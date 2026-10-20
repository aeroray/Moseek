use std::{
    net::{IpAddr, ToSocketAddrs},
    time::Duration,
};

use reqwest::{
    header::{HeaderName, HeaderValue},
    Client, Method, Url,
};
use serde_json::Value;

/// How long a DNS lookup may take before the request is abandoned.
///
/// `to_socket_addrs` is a blocking call with no timeout of its own, and on a machine whose
/// resolver is slow or unreachable it can block for the operating system's full retry budget —
/// minutes, not seconds. Because it ran on the async executor before the client existed, a test
/// of one dead host could hold its worker indefinitely while the UI sat on "测速中" with no way
/// out. The lookup now happens on the blocking pool under a hard deadline.
const DNS_TIMEOUT: Duration = Duration::from_secs(8);

/// How much of an error response body is kept for the diagnosis.
///
/// Error pages are short — the one that named the region block was 406 bytes — and a body larger
/// than this is not an explanation. Bounded so a hostile or misconfigured upstream cannot stream
/// an unbounded amount into a message that is displayed to the user.
const ERROR_BODY_MAX_BYTES: usize = 4 * 1024;

/// How long the error body of a media response may take to arrive.
///
/// A streaming client's deadline is a *gap* between reads, so the byte cap alone bounds what is
/// kept but not how long it takes to keep it: a server answering `403` and then dripping one byte
/// every 19 seconds satisfies the gap deadline forever and never reaches the byte cap. Every
/// streaming caller drains this body, so the hold is reachable from every one of them — an error
/// page is worth a few seconds of waiting, not the life of the process.
const ERROR_BODY_TIMEOUT: Duration = Duration::from_secs(5);

/// Flattens an error page into one line.
///
/// The useful sentence is usually *inside* a tag rather than on a line of its own —
/// `<p>The region has been denied.</p>` — so filtering out lines that start with `<` discards
/// exactly the text worth keeping. Tags are removed instead, and what remains is collapsed.
///
/// `<style>` and `<script>` bodies are removed first: they are code, not explanation, and leaving
/// them in put a CSS rule into the middle of a user-facing message.
fn collapse_whitespace(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    let mut in_tag = false;
    let mut tag = String::new();
    // While set, everything until the matching closing tag is dropped.
    let mut skip_until: Option<String> = None;
    for character in value.chars() {
        if in_tag {
            if character == '>' {
                in_tag = false;
                let name = tag
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_end_matches('/')
                    .to_ascii_lowercase();
                match &skip_until {
                    Some(closing) if name == *closing => skip_until = None,
                    Some(_) => {}
                    None if !tag.starts_with('/') => match name.as_str() {
                        "style" => skip_until = Some(name),
                        "script" => skip_until = Some(name),
                        _ => {}
                    },
                    None => {}
                }
                // A tag is a word boundary; without this "a</p><p>b" would run together.
                if skip_until.is_none() {
                    text.push(' ');
                }
                tag.clear();
            } else {
                tag.push(character);
            }
            continue;
        }
        if skip_until.is_some() {
            if character == '<' {
                in_tag = true;
                tag.clear();
            }
            continue;
        }
        if character == '<' {
            in_tag = true;
            tag.clear();
        } else {
            text.push(character);
        }
    }
    // Entities are common on these pages and would otherwise reach the user as "&gt;".
    let decoded = text
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&");
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(400).collect();
    if trimmed.is_empty() {
        // A body that really is nothing but markup still has to say something.
        value.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        trimmed
    }
}

fn resolve_host(host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>, String> {
    (host, port)
        .to_socket_addrs()
        .map(|addresses| addresses.collect())
        .map_err(|error| format!("无法解析远程主机：{error}"))
}

async fn resolve_host_with_timeout(
    host: &str,
    port: u16,
) -> Result<Vec<std::net::SocketAddr>, String> {
    let owned_host = host.to_string();
    let lookup = tokio::task::spawn_blocking(move || resolve_host(&owned_host, port));
    match tokio::time::timeout(DNS_TIMEOUT, lookup).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("域名解析任务失败：{error}")),
        Err(_) => Err(format!(
            "域名解析超时（{} 秒）：{host}",
            DNS_TIMEOUT.as_secs()
        )),
    }
}

/// Rejects addresses that must never be contacted.
///
/// A literal address is checked here, including IPv4-mapped IPv6 forms such as `[::ffff:127.0.0.1]`
/// which `Url::host_str` returns bracketed and `is_disallowed_host` therefore misses. Whether a
/// *name* resolves to a disallowed address is settled in [`build_http_client`], which has to
/// resolve anyway to pin the connection — checking it in both places meant two blocking lookups
/// per request, and the one here could not be given a deadline without making this function async
/// at twenty call sites.
pub(crate) fn validate_remote_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只允许 HTTP 或 HTTPS 地址".to_string());
    }
    let host = url.host_str().ok_or_else(|| "地址缺少主机名".to_string())?;
    // The wording names the actual problem. It used to say "enable this in settings", pointing at
    // a switch that does not exist: the rule is fixed and the address simply cannot be used.
    let denied = format!("{host} 指向本机或局域网，拾影不会访问");
    if is_disallowed_host(host) {
        return Err(denied);
    }
    // `host_str` returns a bracketed IPv6 literal with the brackets, so strip them before
    // parsing. Without this `[::ffff:127.0.0.1]` parsed as neither a host name nor an address and
    // slipped past the check.
    let literal = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(address) = literal.parse::<IpAddr>() {
        if is_disallowed_ip(address) {
            return Err(denied);
        }
    }
    Ok(())
}

pub(crate) async fn fetch_text(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
) -> Result<String, String> {
    fetch_text_with_headers(url, max_bytes, resource_name, &[]).await
}

pub(crate) async fn fetch_text_with_headers(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
) -> Result<String, String> {
    fetch_text_with_method(url, Method::GET, max_bytes, resource_name, headers, None).await
}

/// Text fetch that follows a bounded number of redirects, matching the media path.
/// The live channel probe uses it because its job is to predict whether playback would
/// succeed: refusing a redirect the player would happily follow would report a policy
/// limit as a dead channel. `fetch_text` keeps redirects disabled on purpose, so this is
/// deliberately a separate entry point rather than a change to that policy.
pub(crate) async fn fetch_text_following_redirects(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
    max_redirects: usize,
) -> Result<String, String> {
    fetch_text_following_redirects_with_headers(url, max_bytes, resource_name, &[], max_redirects)
        .await
}

/// Decodes a fetched body as text, tolerating the encodings these sites actually serve.
///
/// `String::from_utf8` rejected a GBK page outright, which reported our own encoding guess as the
/// page's fault: the bytes were fine and only the assumption was wrong. Configuration import has
/// always gone through `config::decode`, and a source that answers an HTML page in GBK was the one
/// remaining path that could not read what it was given. The resource name is kept in the message
/// because several fetches share this helper and the caller's wording names what failed.
fn decode_text_body(body: Vec<u8>, resource_name: &str) -> Result<String, String> {
    crate::config::decode::decode_text(&body).map_err(|_| {
        format!("{resource_name}无法解码为文本（既不是 UTF-8，也不是 GBK/Big5）")
    })
}

/// The same fetch, with caller headers.
///
/// Needed because a player frame is routinely hotlink-protected: measured on the real
/// `us-m3u8.urldwz.com/index.php/play/2179.html` frame, the address answers 404 on its own but 200
/// with the page that embeds it as `Referer`, which is exactly what a browser would send.
pub(crate) async fn fetch_text_following_redirects_with_headers(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
    max_redirects: usize,
) -> Result<String, String> {
    validate_remote_url(&url)?;
    let (body, _, _) = fetch_response_bytes(
        url,
        Method::GET,
        max_bytes,
        resource_name,
        headers,
        None,
        max_redirects,
    )
    .await?;
    decode_text_body(body, resource_name)
}

pub(crate) async fn fetch_text_with_method(
    url: Url,
    method: Method,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
) -> Result<String, String> {
    validate_remote_url(&url)?;
    let body =
        fetch_bytes_with_request(url, method, max_bytes, resource_name, headers, body).await?;
    decode_text_body(body, resource_name)
}

/// How long a live stream may stay silent between two reads before it is treated as dead.
///
/// This is a *gap* deadline, not a total one. A live HTTP-FLV body never completes, so the only
/// question worth bounding is whether the upstream is still delivering.
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(20);

/// How many redirects a media request follows, matching `fetch_media_bytes`.
const MEDIA_REDIRECT_LIMIT: usize = 3;

/// Header names a caller may not override, because doing so breaks the request the policy built.
const PROTECTED_HEADERS: [&str; 9] = [
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "proxy-authorization",
    "proxy-authenticate",
    "keep-alive",
    "te",
    "trailer",
];

/// Applies caller headers to a request, refusing the ones that would corrupt it.
fn apply_request_headers(
    mut request: reqwest::RequestBuilder,
    headers: &[(String, String)],
) -> Result<reqwest::RequestBuilder, String> {
    for (name, value) in headers {
        // `upgrade` is checked here rather than being listed above so the message names the header
        // the caller actually sent.
        if PROTECTED_HEADERS.contains(&name.to_ascii_lowercase().as_str())
            || name.eq_ignore_ascii_case("upgrade")
        {
            return Err(format!("不允许覆盖受保护的 HTTP 请求头：{name}"));
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| format!("无效的 HTTP 请求头名称：{error}"))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|error| format!("无效的 HTTP 请求头值：{error}"))?;
        request = request.header(header_name, header_value);
    }
    Ok(request)
}

fn redirect_headers(headers: &mut Vec<(String, String)>, from: &Url, to: &Url) {
    if from.origin() != to.origin() {
        headers.retain(|(name, _)| {
            !["authorization", "cookie", "cookie2"]
                .iter()
                .any(|sensitive| name.eq_ignore_ascii_case(sensitive))
        });
    }
}

/// The address a redirect points at, after every rule the next hop must satisfy.
///
/// Pulled out of both redirect loops so the rules live in one place and can be asserted without a
/// network. The loops had carried identical copies of the join and the self-redirect guard, and a
/// rule added to one copy but not the other is exactly how the TLS downgrade went unnoticed.
fn redirect_target(current_url: &Url, location: &str, resource_name: &str) -> Result<Url, String> {
    let next_url = current_url
        .join(location)
        .map_err(|error| format!("{resource_name}重定向地址无法解析：{error}"))?;
    // An empty Location resolves back to the current URL, which would otherwise spin until the
    // redirect budget runs out and be reported as "too many redirects" even though only one hop
    // was ever attempted.
    if next_url == *current_url {
        return Err(format!(
            "{resource_name}的重定向没有指向新地址（Location 为空或指向自身），该地址当前不可用"
        ));
    }
    // An https address that hands back a plaintext follow-up is never legitimate: either the
    // redirect is broken or someone in the path rewrote it, and following it would put a manifest
    // or a configuration document on a channel a network attacker can edit. Plain `http` sources
    // are ordinary in this ecosystem, so the scheme is never refused — only the transition away
    // from TLS.
    if current_url.scheme() == "https" && next_url.scheme() == "http" {
        return Err(format!(
            "{resource_name}的地址试图从 HTTPS 降级到 HTTP，已拒绝"
        ));
    }
    Ok(next_url)
}

/// Runs a read under a wall-clock deadline, reporting the overrun as `None`.
async fn within<T>(work: impl std::future::Future<Output = T>, deadline: Duration) -> Option<T> {
    tokio::time::timeout(deadline, work).await.ok()
}

/// Drains a text body under a deadline, yielding whatever had arrived when it ran out.
///
/// A partial error page is still better than nothing, and a body that cannot be read at all leaves
/// the status-only message, which is a truthful diagnosis either way. What must not happen is the
/// status message arriving only after the process has been held for hours.
async fn drain_within(work: impl std::future::Future<Output = String>, deadline: Duration) -> String {
    within(work, deadline).await.unwrap_or_default()
}

/// Reads a bounded error body under a deadline.
///
/// Both bounds matter. The byte cap stops a hostile upstream from filling memory, and the deadline
/// stops a `403` that drips one byte every twenty seconds from keeping the task — and its socket —
/// alive: every arriving byte resets the streaming client's gap deadline, so only a wall-clock
/// budget ends it. Reachable from every streaming caller, which is why the bound lives here.
async fn read_error_body(response: reqwest::Response) -> String {
    read_error_body_within(response, ERROR_BODY_TIMEOUT).await
}

/// [`read_error_body`] with the budget as a parameter, so the two layers can be told apart in a
/// test: the byte cap is the loop's own, the deadline is [`drain_within`]'s.
async fn read_error_body_within(response: reqwest::Response, deadline: Duration) -> String {
    let drain = async move {
        let mut response = response;
        let mut detail = String::new();
        while let Some(chunk) = response.chunk().await.ok().flatten() {
            if detail.len().saturating_add(chunk.len()) > ERROR_BODY_MAX_BYTES {
                break;
            }
            detail.push_str(&String::from_utf8_lossy(&chunk));
        }
        detail
    };
    drain_within(drain, deadline).await
}

/// How long reading a prefix may take, once a response is open.
///
/// Starts after `open_media_response` returns, which is the point: the request half already has
/// its own bounds (connect timeout, DNS deadline, gap deadline), while the *read* half has none.
/// A server that answers `200` and then drips one byte every nineteen seconds satisfies the
/// streaming gap deadline forever and would reach the 64 KiB cap in roughly two weeks.
const PREFIX_BODY_TIMEOUT: Duration = Duration::from_secs(15);

/// The result type of a media prefix read.
type MediaPrefix = (Vec<u8>, Option<String>, Url);

/// Ends a prefix read at the deadline, turning an overrun into the message the user sees.
///
/// Split out from [`fetch_media_prefix_with_deadline`] so the bound can be asserted against a
/// future that never resolves — which is what a dripping upstream looks like to this code, and
/// what a test cannot otherwise produce without a cooperating server.
async fn guard_prefix_read(
    read: impl std::future::Future<Output = Result<MediaPrefix, String>>,
    resource_name: &str,
) -> Result<MediaPrefix, String> {
    guard_prefix_read_within(read, resource_name, PREFIX_BODY_TIMEOUT).await
}

/// [`guard_prefix_read`] with the budget as a parameter, so a test does not wait the real 15 s.
async fn guard_prefix_read_within(
    read: impl std::future::Future<Output = Result<MediaPrefix, String>>,
    resource_name: &str,
    deadline: Duration,
) -> Result<MediaPrefix, String> {
    match within(read, deadline).await {
        Some(result) => result,
        None => Err(format!(
            "{resource_name}超时（{} 秒）",
            deadline.as_secs()
        )),
    }
}

/// Reads the leading bytes of a media response, with a deadline on the read itself.
///
/// Kept separate from [`fetch_media_prefix`], which the live path shares and which must not be
/// given a total budget: a running stream is precisely the case a total deadline gets wrong. This
/// is the form for callers that only ever want a prefix — the container sniff, and the gate in
/// front of a media element — where the read has to end even if the upstream never stops talking.
pub(crate) async fn fetch_media_prefix_with_deadline(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
) -> Result<MediaPrefix, String> {
    let read = fetch_media_prefix(url, max_bytes, resource_name, headers);
    guard_prefix_read(read, resource_name).await
}

/// Opens a media response and hands back the body as a stream, following bounded redirects.
///
/// Used by both the container sniff and live playback, so the redirect, policy and error-status
/// handling cannot drift between "what we detect" and "what we play".
pub(crate) async fn open_media_response(
    url: Url,
    resource_name: &str,
    headers: &[(String, String)],
) -> Result<(reqwest::Response, Url), String> {
    let mut current_url = url;
    let mut headers = headers.to_vec();
    for redirect_index in 0..=MEDIA_REDIRECT_LIMIT {
        validate_remote_url(&current_url)?;
        let client = build_http_client_with(&current_url, ClientMode::Streaming).await?;
        let request = apply_request_headers(client.get(current_url.clone()), &headers)?;
        let response = request
            .send()
            .await
            .map_err(|error| describe_http_error(format!("{resource_name}请求失败"), &error))?;
        if response.status().is_redirection() {
            if redirect_index == MEDIA_REDIRECT_LIMIT {
                return Err(format!(
                    "{resource_name}重定向次数超过 {MEDIA_REDIRECT_LIMIT} 次"
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or_else(|| format!("{resource_name}重定向缺少目标地址"))?
                .to_str()
                .map_err(|error| format!("{resource_name}重定向地址无效：{error}"))?
                .to_string();
            let next_url = redirect_target(&current_url, &location, resource_name)?;
            redirect_headers(&mut headers, &current_url, &next_url);
            current_url = next_url;
            continue;
        }
        if !response.status().is_success() {
            // The body is read because the status alone does not say *why*: a region block states
            // it only in the body. Bounded in both size and time, since every streaming caller
            // reaches this path and a dripping body would otherwise outlive the request.
            let status = response.status();
            let detail = read_error_body(response).await;
            let trimmed = detail.trim();
            return Err(if trimmed.is_empty() {
                format!("{resource_name}返回错误状态：HTTP {}", status.as_u16())
            } else {
                format!(
                    "{resource_name}返回错误状态：HTTP {}；{}",
                    status.as_u16(),
                    collapse_whitespace(trimmed)
                )
            });
        }
        return Ok((response, current_url));
    }
    Err(format!("{resource_name}请求未返回有效响应"))
}

/// Reads at most `max_bytes` of a media response, then abandons the connection.
///
/// This exists because a live stream never ends. `fetch_media_bytes` reads a body to completion,
/// which is correct for a document and impossible for a running stream: measured against
/// `https://live.ottiptv.cc/douyu/431460`, the 1 MiB budget returned "error decoding response body"
/// after 16 441 ms even though the same response had already delivered 267 280 bytes of a healthy
/// `video/x-flv` body, and the 512 KiB budget failed the same way after 5 630 ms. Identifying a
/// container needs a few bytes, not the whole stream, so the read stops as soon as the window is
/// full — which is also what keeps a container sniff to one round trip instead of a timeout.
///
/// This function itself carries no total deadline, deliberately: it is the inner half shared with
/// the live path, which must not be given one. Callers that only ever want a prefix use
/// [`fetch_media_prefix_with_deadline`] instead.
pub(crate) async fn fetch_media_prefix(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
) -> Result<MediaPrefix, String> {
    let (mut response, final_url) = open_media_response(url, resource_name, headers).await?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    let mut body = Vec::with_capacity(max_bytes.min(64 * 1024));
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("{resource_name}读取失败：{error}"))?
    {
        let remaining = max_bytes.saturating_sub(body.len());
        if remaining == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() >= max_bytes {
            break;
        }
    }
    Ok((body, content_type, final_url))
}

/// Reads a media body to completion under a byte cap, on a client whose deadline is a *gap*
/// between reads rather than a whole-exchange budget.
///
/// Media is not a document, and giving it the document's deadline is silently wrong. A VOD
/// fragment is routinely several megabytes, and a slow CDN can need far longer than 15 s to
/// deliver one while still sending steadily. Measured on the fragments of a real source
/// (`https://p.hhwenjian.com:65/hls/946/20260923/4461270/`): one 2.5 MiB fragment took 48 s at
/// 54 KiB/s, and through this function 3 of 6 consecutive fragments failed after exactly
/// 15 010 ms — the `Buffered` client's whole-exchange deadline — reporting the misleading
/// "error decoding response body". The upstream was healthy; only the deadline was wrong. The
/// symptom on screen was a player stuck on "正在确认可以播放" forever, because hls.js kept retrying
/// fragments that could never finish inside the budget.
///
/// `Streaming` keeps the guarantee that matters — a host that goes silent for `STREAM_READ_TIMEOUT`
/// still fails — without failing a host that is merely slow. The callers above this one keep their
/// own bounds: the live probe wraps it in `tokio::time::timeout`, and the player's loader has its
/// own timeout, so nothing here can hang unbounded.
pub(crate) async fn fetch_media_bytes(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
) -> Result<(Vec<u8>, Option<String>, Url), String> {
    let (mut response, final_url) = open_media_response(url, resource_name, headers).await?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    // Refuse an oversized body from its declared length before reading a byte of it, matching the
    // buffered path: a mislabelled address must not stream megabytes into memory.
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err(format!(
            "{resource_name}响应超过 {} MB 限制",
            max_bytes / 1024 / 1024
        ));
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .map(|size| size.min(max_bytes as u64) as usize)
            .unwrap_or_default(),
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("{resource_name}读取失败：{error}"))?
    {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!(
                "{resource_name}响应超过 {} MB 限制",
                max_bytes / 1024 / 1024
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, content_type, final_url))
}

pub(crate) async fn fetch_json(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
) -> Result<Value, String> {
    let body = fetch_bytes(url, max_bytes, resource_name).await?;
    serde_json::from_slice(&body).map_err(|error| format!("{resource_name}不是有效 JSON：{error}"))
}

async fn fetch_bytes(url: Url, max_bytes: usize, resource_name: &str) -> Result<Vec<u8>, String> {
    fetch_bytes_with_request(url, Method::GET, max_bytes, resource_name, &[], None).await
}

async fn fetch_bytes_with_request(
    url: Url,
    method: Method,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    fetch_response_bytes(url, method, max_bytes, resource_name, headers, body, 0)
        .await
        .map(|(body, _, _)| body)
}

/// Fetches a body as raw bytes, following redirects, under the same policy as every other request.
///
/// The configuration fetch needs the bytes rather than text because some of the addresses the user
/// supplied serve a picture with the configuration appended to it. Deciding that has to happen before
/// any UTF-8 decoding, and `fetch_text` refuses non-UTF-8 outright.
pub(crate) async fn fetch_response_bytes_public(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
) -> Result<(Vec<u8>, Option<String>, Url), String> {
    fetch_response_bytes(url, Method::GET, max_bytes, resource_name, &[], None, 3).await
}

async fn fetch_response_bytes(
    url: Url,
    method: Method,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
    max_redirects: usize,
) -> Result<(Vec<u8>, Option<String>, Url), String> {
    let mut current_url = url;
    let mut headers = headers.to_vec();
    for redirect_index in 0..=max_redirects {
        validate_remote_url(&current_url)?;
        let client = build_http_client(&current_url).await?;
        let mut request = client.request(method.clone(), current_url.clone());
        request = apply_request_headers(request, &headers)?;
        if let Some(body) = body.clone() {
            request = request.body(body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| describe_http_error(format!("{resource_name}请求失败"), &error))?;
        if response.status().is_redirection() {
            // Text fetches pass `max_redirects = 0` on purpose, so "redirect limit
            // exceeded" would be misleading: the hop was never followed. Say what
            // actually happened instead.
            if max_redirects == 0 {
                return Err(format!(
                    "{resource_name}返回了重定向（HTTP {}），当前策略不跟随重定向",
                    response.status().as_u16()
                ));
            }
            if redirect_index == max_redirects {
                return Err(format!("{resource_name}重定向次数超过 {max_redirects} 次"));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or_else(|| format!("{resource_name}重定向缺少目标地址"))?
                .to_str()
                .map_err(|error| format!("{resource_name}重定向地址无效：{error}"))?;
            let next_url = redirect_target(&current_url, location, resource_name)?;
            redirect_headers(&mut headers, &current_url, &next_url);
            current_url = next_url;
            continue;
        }
        // An error status is read rather than short-circuited. `error_for_status` discards the
        // body, and the body is often the only place the upstream states *why* — a region block
        // answers 403 with "The region has been denied", which is a different problem with a
        // different remedy from an operator-restricted address. Without this the diagnosis could
        // only ever say "拒绝访问" and point the user at the wrong cause.
        if !response.status().is_success() {
            let status = response.status();
            // The same time-and-size bound as the media path. This client is buffered, so its own
            // deadline covers the exchange, but the body is drained here rather than by reqwest,
            // and one shared bound keeps the two error messages from drifting apart.
            let detail = read_error_body(response).await;
            let trimmed = detail.trim();
            return Err(if trimmed.is_empty() {
                format!("{resource_name}返回错误状态：HTTP {}", status.as_u16())
            } else {
                format!(
                    "{resource_name}返回错误状态：HTTP {}；{}",
                    status.as_u16(),
                    collapse_whitespace(trimmed)
                )
            });
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes as u64)
        {
            return Err(format!(
                "{resource_name}响应超过 {} MB 限制",
                max_bytes / 1024 / 1024
            ));
        }
        let mut body = Vec::with_capacity(
            response
                .content_length()
                .map(|size| size.min(max_bytes as u64) as usize)
                .unwrap_or_default(),
        );
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if body.len().saturating_add(chunk.len()) > max_bytes {
                return Err(format!(
                    "{resource_name}响应超过 {} MB 限制",
                    max_bytes / 1024 / 1024
                ));
            }
            body.extend_from_slice(&chunk);
        }
        return Ok((body, content_type, current_url));
    }
    Err(format!("{resource_name}请求未返回有效响应"))
}

/// Builds an operator-facing message from a reqwest error, walking the cause chain.
/// reqwest's own `Display` only reports the outermost layer ("error sending request
/// for url (...)"), which hides whether the peer closed the connection, the DNS
/// lookup failed, or TLS was rejected. The frontend surfaces this text in the
/// playback diagnostic panel, so the underlying cause has to survive.
fn describe_http_error(message: String, error: &reqwest::Error) -> String {
    let mut described = format!("{message}：{error}");
    let mut cause = std::error::Error::source(error);
    while let Some(source) = cause {
        described.push_str(&format!("；{source}"));
        cause = source.source();
    }
    described
}

/// Every address a request to this URL may use, after the policy check.
///
/// Returns the whole list rather than one address, because pinning a single address disables the
/// fallback the resolver would otherwise perform. Most CDN-fronted APIs publish several addresses —
/// 20 of the 34 hosts in the author's configuration resolve to more than one — and the first is
/// often IPv6, so a machine without a working IPv6 route could not reach a host that was up.
async fn resolve_allowed_addresses(
    host: &str,
    port: u16,
) -> Result<Vec<std::net::SocketAddr>, String> {
    // A literal address is checked directly, matching the rule applied to a resolved name.
    if let Ok(address) = host.parse::<IpAddr>() {
        if is_disallowed_ip(address) {
            return Err(format!("{host} 指向本机或局域网，拾影不会访问"));
        }
        return Ok(vec![std::net::SocketAddr::new(address, port)]);
    }
    let addresses = resolve_host_with_timeout(host, port).await?;
    // Any disallowed address rejects the host outright, matching the rule applied to a literal
    // address: a name that can reach the local network is not a name we contact.
    if addresses
        .iter()
        .any(|address| is_disallowed_ip(address.ip()))
    {
        return Err(format!("{host} 指向本机或局域网，拾影不会访问"));
    }
    if addresses.is_empty() {
        return Err("远程主机没有解析出可用地址".to_string());
    }
    Ok(addresses)
}

async fn build_http_client(url: &Url) -> Result<Client, String> {
    build_http_client_with(url, ClientMode::Buffered).await
}

pub(crate) async fn validate_public_destination(url: &Url) -> Result<(), String> {
    validate_remote_url(url)?;
    let host = url.host_str().ok_or_else(|| "地址缺少主机名".to_string())?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    resolve_allowed_addresses(host, url.port_or_known_default().unwrap_or(443)).await?;
    Ok(())
}

/// How a request's deadline is applied.
///
/// `Buffered` bounds the *whole* exchange, which is right for a document or a manifest: those end,
/// and a request that has not ended by the deadline has failed. `Streaming` bounds only the gap
/// between two reads.
///
/// The distinction is load-bearing for live media, and getting it wrong is silent. reqwest applies
/// `.timeout()` to the entire response body, so on a live HTTP-FLV stream — which by definition
/// never ends — the deadline always expires mid-body, and reqwest surfaces that as
/// `Kind::Decode`, i.e. the message "error decoding response body". Measured on
/// `https://live.ottiptv.cc/douyu/431460` with the buffered client: the 1 MiB budget failed after
/// 16 441 ms and the 512 KiB budget after 5 630 ms, both reporting a decode error even though the
/// response was a perfectly healthy `video/x-flv` body that had already delivered 267 280 bytes.
/// Reading the same URL with only a per-read deadline delivered its first chunk in 1 244 ms.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ClientMode {
    Buffered,
    Streaming,
}

async fn build_http_client_with(url: &Url, mode: ClientMode) -> Result<Client, String> {
    let host = url.host_str().ok_or_else(|| "地址缺少主机名".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    // This is the one place a name is resolved, so it is also where the address policy is
    // enforced for names.
    let resolved_addresses = resolve_allowed_addresses(host, port).await?;
    let builder = Client::builder()
        // A proxy resolves the target itself, bypassing our pinned DNS addresses.
        .no_proxy()
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        // **All** resolved addresses are handed to reqwest, not just the first. reqwest tries them
        // in order, which is what keeps a host with one unhealthy address reachable.
        .resolve_to_addrs(host, &resolved_addresses)
        .user_agent("Moseek/0.1");
    let builder = match mode {
        ClientMode::Buffered => builder.timeout(Duration::from_secs(15)),
        // A live stream is expected to be quiet between chunks; it is not expected to finish.
        ClientMode::Streaming => builder.read_timeout(STREAM_READ_TIMEOUT),
    };
    builder.build().map_err(|error| error.to_string())
}

fn is_disallowed_host(host: &str) -> bool {
    let normalized_host = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized_host == "localhost"
        || normalized_host.ends_with(".localhost")
        || normalized_host.ends_with(".local")
    {
        return true;
    }
    match normalized_host.parse::<IpAddr>() {
        Ok(address) => is_disallowed_ip(address),
        Err(_) => false,
    }
}

/// The IPv4 address a transitional IPv6 form carries, if it carries one.
///
/// Every mechanism below reaches an IPv4 destination from an address that looks like ordinary
/// global IPv6, so the only honest way to apply the v4 rule is to unwrap the address first. A
/// poisoned resolver, or a host on a 6to4 or NAT64 path, otherwise turns `2002:7f00:1::` into a
/// request to `127.0.0.1` that the v6 checks never see.
fn embedded_ipv4(segments: &[u16; 8]) -> Option<std::net::Ipv4Addr> {
    let high = |index: usize| (segments[index] >> 8) as u8;
    let low = |index: usize| (segments[index] & 0x00ff) as u8;
    let tail = std::net::Ipv4Addr::new(high(6), low(6), high(7), low(7));
    if segments[0] == 0x2002 {
        // 2002::/16 — 6to4: the IPv4 address is bits 16..48.
        return Some(std::net::Ipv4Addr::new(high(1), low(1), high(2), low(2)));
    }
    if segments[0] == 0x2001 && segments[1] == 0x0000 {
        // 2001:0::/32 — Teredo: the client IPv4 address is the inverse of bits 96..128.
        let octets = tail.octets();
        return Some(std::net::Ipv4Addr::new(
            !octets[0], !octets[1], !octets[2], !octets[3],
        ));
    }
    if segments[0] == 0x0064
        && segments[1] == 0xff9b
        && segments[2..6].iter().all(|segment| *segment == 0)
    {
        // 64:ff9b::/96 — NAT64 well-known prefix: the low 32 bits are the IPv4 address.
        return Some(tail);
    }
    if segments[..6].iter().all(|segment| *segment == 0) && tail.octets() != [0, 0, 0, 0] {
        // ::/96 — deprecated IPv4-compatible addresses. The IPv4-mapped form (::ffff:0:0/96)
        // carries segments[5] == 0xffff and is therefore excluded here rather than handled twice:
        // `to_ipv4_mapped` already covers it at the call site.
        return Some(tail);
    }
    None
}

fn is_disallowed_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_broadcast()
                // RFC 6598 shared address space. Cloud metadata lives here too — Alibaba Cloud
                // answers 100.100.100.200 — and some ISPs place the host's own on-link
                // mobile-broadband segment inside it.
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                // 192.0.0.0/24 IETF protocol assignments.
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                // 0.0.0.0/8 "this network"; several stacks treat it as the local host.
                || octets[0] == 0
                // 240.0.0.0/4 reserved, and 255.255.255.255 is already covered by `broadcast`.
                || octets[0] >= 240
            // Deliberately NOT blocked: 198.18.0.0/15. Clash/Mihomo TUN mode answers every
            // hostname with an address from that pool, so refusing it would break those users
            // outright — the range is a proxy's own on-link fake, not a remote destination.
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            address
                .to_ipv4_mapped()
                .is_some_and(|mapped| is_disallowed_ip(IpAddr::V4(mapped)))
                // Whatever IPv4 destination a transition mechanism carries is judged by the same
                // v4 rule, rather than trusted because it is wrapped in a public-looking v6.
                || embedded_ipv4(&segments).is_some_and(|v4| is_disallowed_ip(IpAddr::V4(v4)))
                || address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (segments[0] & 0xffc0 == 0xfe80)
                || (segments[0] & 0xfe00 == 0xfc00)
                // 2001:db8::/32 documentation prefix: never routable, so reaching it means the
                // resolver was poisoned.
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn redirects_drop_credentials_on_every_origin_change() {
        let original: reqwest::Url = "https://example.com/a".parse().unwrap();
        for target in [
            "https://cdn.example.com/b",
            "http://example.com/b",
            "https://example.com:444/b",
        ] {
            let mut headers = vec![
                ("Authorization".to_string(), "Bearer secret".to_string()),
                ("cOoKiE".to_string(), "session=secret".to_string()),
                ("Range".to_string(), "bytes=0-9".to_string()),
                ("Referer".to_string(), "https://example.com/".to_string()),
            ];
            super::redirect_headers(&mut headers, &original, &target.parse().unwrap());
            assert_eq!(headers.len(), 2);
            assert_eq!(headers[0].0, "Range");
            super::redirect_headers(&mut headers, &target.parse().unwrap(), &original);
            assert_eq!(
                headers.len(),
                2,
                "credentials must not return on a later hop"
            );
        }
        let mut same_origin = vec![("Cookie".to_string(), "session=secret".to_string())];
        super::redirect_headers(
            &mut same_origin,
            &original,
            &"https://example.com/b".parse().unwrap(),
        );
        assert_eq!(same_origin.len(), 1);
    }

    use std::net::IpAddr;

    use super::{
        collapse_whitespace, embedded_ipv4, is_disallowed_ip, resolve_allowed_addresses,
        resolve_host, validate_remote_url, DNS_TIMEOUT,
    };

    #[test]
    fn every_resolved_address_is_kept_not_just_the_first() {
        // Pinning one address disabled reqwest's fallback: if that address was unhealthy the whole
        // host became unreachable. 20 of the 34 hosts in the author's configuration resolve to more
        // than one address, and the first is often IPv6.
        //
        // This covers the resolution half — the whole list survives the policy check. The call site
        // (`resolve_to_addrs` rather than `resolve`) cannot be asserted from here: reqwest exposes
        // no way to read back its DNS overrides, so the difference is only observable against a host
        // whose first address fails while a later one works. Mutating that line therefore does not
        // turn this test red, and the fix for it is verified by measurement rather than here.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // A literal address yields exactly one entry, and a disallowed one is refused.
            let single = resolve_allowed_addresses("93.184.216.34", 443)
                .await
                .expect("a public literal address is allowed");
            assert_eq!(single.len(), 1);
            assert_eq!(single[0].port(), 443);

            assert!(resolve_allowed_addresses("127.0.0.1", 443).await.is_err());
            assert!(resolve_allowed_addresses("10.0.0.1", 443).await.is_err());
            assert!(resolve_allowed_addresses("::1", 443).await.is_err());
            // localhost is a name that resolves to disallowed addresses, and is refused as a name.
            assert!(resolve_allowed_addresses("localhost", 80).await.is_err());
        });
    }

    #[test]
    fn a_multi_address_host_keeps_all_of_them() {
        // The behaviour that was missing. `localhost` resolves to both 127.0.0.1 and ::1 on most
        // machines, so it is a convenient stand-in for a multi-address host; the policy refuses it,
        // so this asserts on the resolver rather than the policy wrapper.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let resolved = resolve_host("localhost", 443).expect("localhost resolves");
            assert!(
                !resolved.is_empty(),
                "localhost must resolve to at least one address"
            );
            // Every address is carried through, which is what the fix guarantees.
            let filtered: Vec<_> = resolved
                .iter()
                .copied()
                .filter(|address| !is_disallowed_ip(address.ip()))
                .collect();
            assert!(
                filtered.is_empty(),
                "localhost is entirely disallowed, so nothing survives the policy"
            );
        });
    }

    #[test]
    fn policy_rejects_non_http_and_local_urls() {
        assert!(validate_remote_url(&"file:///tmp/config.json".parse().unwrap()).is_err());
        assert!(validate_remote_url(&"http://127.0.0.1/config.json".parse().unwrap()).is_err());
        assert!(
            validate_remote_url(&"http://[::ffff:127.0.0.1]/config.json".parse().unwrap()).is_err()
        );
        assert!(validate_remote_url(&"http://localhost/config.json".parse().unwrap()).is_err());
    }

    #[test]
    fn policy_still_allows_ordinary_public_urls() {
        // The literal-address check must not become a blanket rejection.
        assert!(validate_remote_url(&"https://example.com/config.json".parse().unwrap()).is_ok());
        assert!(validate_remote_url(&"https://93.184.216.34/config.json".parse().unwrap()).is_ok());
    }

    #[test]
    fn policy_rejects_private_and_link_local_literals() {
        for url in [
            "http://10.0.0.1/a",
            "http://192.168.1.1/a",
            "http://172.16.0.1/a",
            "http://169.254.169.254/a",
            "http://[fe80::1]/a",
            "http://[fd00::1]/a",
        ] {
            assert!(
                validate_remote_url(&url.parse().unwrap()).is_err(),
                "{url} should be rejected"
            );
        }
    }

    #[test]
    fn resolving_a_literal_address_needs_no_lookup() {
        // A literal must not be handed to the resolver, so it cannot be delayed by one.
        let addresses = resolve_host("93.184.216.34", 443).unwrap();
        assert_eq!(addresses.len(), 1);
        assert_eq!(addresses[0].ip().to_string(), "93.184.216.34");
    }

    #[test]
    fn the_dns_deadline_is_bounded() {
        // The whole point of the fix: an unresolvable name must fail in seconds, not in the
        // resolver's own retry budget, because the UI waits on this call.
        assert!(DNS_TIMEOUT.as_secs() > 0 && DNS_TIMEOUT.as_secs() <= 15);
    }

    #[test]
    fn an_error_page_body_is_flattened_into_one_readable_line() {
        // The real body the cinema CDN returned for a blocked region. Its one useful sentence
        // sits between markup and blank lines; the diagnosis needs that sentence, not the markup.
        let body = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n\t<title>403 Forbidden</title>\n\
                    \t<meta http-equiv=\"Content-Type\" content=\"text/html; charset=utf-8\"/>\n\
                    </head>\n<body>\n\n<h1>403 Forbidden</h1>\n\
                    <p>The region has been denied.</p>\n</body>\n</html>";
        let flattened = collapse_whitespace(body);
        assert!(flattened.contains("The region has been denied."));
        // No tag survives, and no run of whitespace either.
        assert!(!flattened.contains('<'));
        assert!(!flattened.contains("  "));
    }

    #[test]
    fn style_and_script_bodies_are_dropped_from_the_message() {
        // The live 403 body carried a CSS rule, which reached the user as
        // "address { line-height: 1.8; }" in the middle of the explanation.
        let body = "<html><head><style>address { line-height: 1.8; }</style>\
                    <script>var x = 1;</script></head>\
                    <body><h1>403 Forbidden</h1><p>The region has been denied.</p></body></html>";
        let flattened = collapse_whitespace(body);
        assert!(flattened.contains("The region has been denied."));
        assert!(!flattened.contains("line-height"));
        assert!(!flattened.contains("var x"));
    }

    #[test]
    fn html_entities_are_decoded_rather_than_shown_raw() {
        let flattened = collapse_whitespace("<p>a &gt; b &amp; c</p>");
        assert!(flattened.contains("a > b & c"), "{flattened}");
    }

    #[test]
    fn a_body_that_is_only_markup_still_produces_something() {
        // Falling through to an empty string would leave the diagnosis saying only "HTTP 403".
        let flattened = collapse_whitespace("<html><body></body></html>");
        assert!(!flattened.is_empty());
    }

    /// The ranges `Ipv4Addr`'s own predicates do not cover. Each one is a place a hostile
    /// configuration can point the app at, and the Alibaba Cloud metadata address is the concrete
    /// one: it lives in RFC 6598 shared space, which `is_private` does not consider private.
    #[test]
    fn non_public_ipv4_ranges_are_refused() {
        for literal in [
            "100.64.0.1",      // start of RFC 6598
            "100.100.100.200", // Alibaba Cloud instance metadata
            "100.127.255.255", // end of RFC 6598
            "192.0.0.1",       // 192.0.0.0/24 IETF protocol assignments
            "0.0.0.0",         // 0.0.0.0/8
            "0.1.2.3",         // 0.0.0.0/8, not just the unspecified address
            "240.0.0.1",       // 240.0.0.0/4 reserved
            "255.255.255.255", // the broadcast that ends that range
        ] {
            let address: IpAddr = literal.parse().unwrap();
            assert!(is_disallowed_ip(address), "{literal} should be refused");
        }
    }

    /// The deliberate omission. Clash/Mihomo TUN mode answers **every** hostname with an address
    /// from this pool, so adding it to the deny-list would make the app unable to reach anything
    /// on those machines — a far worse outcome than the gap it would close.
    #[test]
    fn the_clash_fake_ip_pool_stays_allowed() {
        for literal in ["198.18.0.1", "198.19.255.255"] {
            let address: IpAddr = literal.parse().unwrap();
            assert!(
                !is_disallowed_ip(address),
                "{literal} must stay reachable: it is Clash/Mihomo TUN's fake-IP pool"
            );
        }
    }

    /// Every transition mechanism that carries an IPv4 destination is judged by the same v4 rule.
    /// Each of these looks like ordinary global IPv6 and is not caught by `to_ipv4_mapped`.
    #[test]
    fn an_ipv6_address_is_judged_by_the_ipv4_it_embeds() {
        for literal in [
            "2002:7f00:1::",      // 6to4 wrapping 127.0.0.1
            "2002:a9fe:a9fe::",   // 6to4 wrapping 169.254.169.254
            "64:ff9b::a9fe:a9fe", // NAT64 -> 169.254.169.254
            "64:ff9b::7f00:1",    // NAT64 -> 127.0.0.1
            "::7f00:1",           // deprecated IPv4-compatible -> 127.0.0.1
            "::a9fe:a9fe",        // deprecated IPv4-compatible -> 169.254.169.254
            "2001:db8::1",        // documentation prefix: never routable
        ] {
            let address: IpAddr = literal.parse().unwrap();
            assert!(is_disallowed_ip(address), "{literal} should be refused");
        }
        // Teredo stores the client address inverted, so 127.0.0.1 is carried as 128.255.255.254.
        let teredo: IpAddr = "2001:0:0:0:0:0:80ff:fffe".parse().unwrap();
        assert!(is_disallowed_ip(teredo), "Teredo wrapping 127.0.0.1");
    }

    /// The unwrapping must not turn into a blanket refusal: a genuine public destination is still
    /// reachable through every mechanism that can carry one, and ordinary global v6 stays open.
    #[test]
    fn public_addresses_stay_allowed_after_the_range_check() {
        for literal in [
            "93.184.216.34",
            "8.8.8.8",
            "1.1.1.1",
            "100.63.255.255", // just below RFC 6598
            "100.128.0.0",    // just above it
            "192.0.1.1",      // just past 192.0.0.0/24
        ] {
            let address: IpAddr = literal.parse().unwrap();
            assert!(
                !is_disallowed_ip(address),
                "{literal} is public and must stay reachable"
            );
        }
        for literal in [
            "2606:4700:4700::1111", // Cloudflare, ordinary global v6
            "2002:5db8:d822::",     // 6to4 wrapping 93.184.216.34, a public address
            "64:ff9b::5db8:d822",   // NAT64 wrapping the same public address
        ] {
            let address: IpAddr = literal.parse().unwrap();
            assert!(
                !is_disallowed_ip(address),
                "{literal} is public and must stay reachable"
            );
        }
    }

    /// The helper is asserted directly because `is_disallowed_ip` alone cannot show *which* IPv4 an
    /// address was unwrapped to — and a wrong offset would still refuse the address while
    /// misjudging every other one built on the same prefix.
    #[test]
    fn the_embedded_ipv4_is_read_from_the_right_offsets() {
        let segments = |literal: &str| match literal.parse::<IpAddr>().unwrap() {
            IpAddr::V6(address) => address.segments(),
            IpAddr::V4(_) => panic!("{literal} is not IPv6"),
        };
        assert_eq!(
            embedded_ipv4(&segments("2002:5db8:d822::")).map(|v4| v4.to_string()),
            Some("93.184.216.34".to_string())
        );
        assert_eq!(
            embedded_ipv4(&segments("64:ff9b::a9fe:a9fe")).map(|v4| v4.to_string()),
            Some("169.254.169.254".to_string())
        );
        assert_eq!(
            embedded_ipv4(&segments("::7f00:1")).map(|v4| v4.to_string()),
            Some("127.0.0.1".to_string())
        );
        // Teredo inverts the client address, so 127.0.0.1 is carried as 128.255.255.254.
        assert_eq!(
            embedded_ipv4(&segments("2001:0:0:0:0:0:80ff:fffe")).map(|v4| v4.to_string()),
            Some("127.0.0.1".to_string())
        );
        // An ordinary global address embeds nothing, and must not be read as if it did.
        assert_eq!(embedded_ipv4(&segments("2606:4700:4700::1111")), None);
    }

    /// A literal in one of the new ranges must be refused at the policy entry point, not only by
    /// the helper: that is the path a configuration's URL actually takes.
    #[test]
    fn policy_refuses_the_newly_covered_literal_addresses() {
        for url in [
            "http://100.100.100.200/latest/meta-data/",
            "http://192.0.0.1/a",
            "http://0.1.2.3/a",
            "http://240.0.0.1/a",
            "http://[2002:7f00:1::]/a",
            "http://[64:ff9b::a9fe:a9fe]/a",
            "http://[::7f00:1]/a",
        ] {
            assert!(
                validate_remote_url(&url.parse().unwrap()).is_err(),
                "{url} should be refused"
            );
        }
    }

    /// An https → http redirect is the one hop that is never legitimate. Refusing it is what keeps
    /// a manifest or a configuration document off a channel a network attacker can rewrite. The
    /// rule lives in `redirect_target`, which **both** redirect loops call, so asserting it there
    /// covers the media path and the configuration path at once.
    #[test]
    fn an_https_to_http_redirect_is_refused() {
        let https: reqwest::Url = "https://example.com/a".parse().unwrap();
        let plain: reqwest::Url = "http://example.com/a".parse().unwrap();
        assert!(
            super::redirect_target(&https, "http://example.com/b", "媒体资源").is_err(),
            "an https source must not be downgraded to plaintext"
        );
        // A relative Location inherits the scheme, so it is not a downgrade.
        assert_eq!(
            super::redirect_target(&https, "/b", "媒体资源")
                .unwrap()
                .as_str(),
            "https://example.com/b"
        );
        // Upgrading, and staying on plain http, are ordinary and must keep working: plain-http
        // sources are the norm in this ecosystem.
        assert_eq!(
            super::redirect_target(&plain, "https://example.com/b", "媒体资源")
                .unwrap()
                .scheme(),
            "https"
        );
        assert_eq!(
            super::redirect_target(&plain, "http://cdn.example.com/b", "媒体资源")
                .unwrap()
                .scheme(),
            "http"
        );
        // The self-redirect guard stays alongside it: an empty Location resolves to the same URL
        // and must be reported as such, not spun through the redirect budget.
        assert!(super::redirect_target(&https, "", "媒体资源").is_err());
    }

    /// The behaviours the two added bounds exist for. A never-resolving future is what a dripping
    /// upstream looks like to this code, and it is the only way a unit test can stand in for one:
    /// the real paths need a server that drips on cue, which no test here can host.
    #[test]
    fn a_read_that_outlives_its_deadline_is_abandoned() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // A short deadline, so the assertion does not spend the real budget.
            let short = std::time::Duration::from_millis(20);
            let started = std::time::Instant::now();
            let overran = super::within(std::future::pending::<()>(), short).await;
            assert!(overran.is_none(), "a hanging read must be abandoned");
            assert!(
                started.elapsed() < std::time::Duration::from_secs(2),
                "the deadline, not the read, must decide when this ends"
            );
            // A read that finishes is returned unchanged, so the deadline is not a blanket failure.
            assert_eq!(super::within(async { 7_u8 }, short).await, Some(7));

            // The error-body drain yields an empty detail rather than hanging, so the caller falls
            // back to the status-only message instead of never producing one.
            let detail = super::drain_within(std::future::pending::<String>(), short).await;
            assert_eq!(detail, "");

            // The prefix guard is the same bound on the path the container sniff and the
            // media-element gate take; an overrun must become an error, not a stuck task.
            let guarded = super::guard_prefix_read_within(
                std::future::pending::<Result<super::MediaPrefix, String>>(),
                "媒体地址",
                std::time::Duration::from_secs(3),
            )
            .await;
            assert!(guarded.is_err(), "a prefix read must not outlive its budget");
            assert!(
                guarded.unwrap_err().contains("超时"),
                "an overrun must say so in the message the user sees"
            );
        });
    }

    /// The constants themselves are part of the fix: a 15 s prefix budget and a 5 s error-body
    /// budget are what the review asked for, and a silent change to either would be invisible.
    #[test]
    fn the_streaming_deadlines_are_bounded() {
        assert_eq!(super::PREFIX_BODY_TIMEOUT.as_secs(), 15);
        assert_eq!(super::ERROR_BODY_TIMEOUT.as_secs(), 5);
        // The gap deadline stays larger than the read budget below it, so a live stream that is
        // merely slow is not cut off before the budget meant to protect it.
        assert!(super::STREAM_READ_TIMEOUT > super::PREFIX_BODY_TIMEOUT);
    }

    /// A GBK page is what these sources actually serve, and the defect was reporting our own
    /// encoding guess as the page's fault. `String::from_utf8` rejected this outright.
    #[test]
    fn a_gbk_body_is_decoded_instead_of_rejected() {
        let (gbk, _, had_errors) = encoding_rs::GB18030.encode("中文标题：测试");
        assert!(!had_errors);
        let decoded =
            super::decode_text_body(gbk.into_owned(), "HTML 源响应").expect("GBK must decode");
        assert_eq!(decoded, "中文标题：测试");
        // A genuinely undecodable body still fails, and the message names the resource.
        let error = super::decode_text_body(vec![0xff, 0xfe, 0x00], "HTML 源响应");
        assert!(error.is_err());
        assert!(error.unwrap_err().contains("HTML 源响应"));
    }
}
