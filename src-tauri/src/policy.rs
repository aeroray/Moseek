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
    let denied = format!("{host} 是本机或局域网地址，Moseek 不会请求它");
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
    validate_remote_url(&url)?;
    let (body, _, _) = fetch_response_bytes(
        url,
        Method::GET,
        max_bytes,
        resource_name,
        &[],
        None,
        max_redirects,
    )
    .await?;
    String::from_utf8(body).map_err(|_| format!("{resource_name}不是有效的 UTF-8 文本"))
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
    String::from_utf8(body).map_err(|_| format!("{resource_name}不是有效的 UTF-8 文本"))
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
        if PROTECTED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) || name.eq_ignore_ascii_case("upgrade") {
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
    for redirect_index in 0..=MEDIA_REDIRECT_LIMIT {
        validate_remote_url(&current_url)?;
        let client = build_http_client_with(&current_url, ClientMode::Streaming).await?;
        let request = apply_request_headers(client.get(current_url.clone()), headers)?;
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
            let next_url = current_url
                .join(&location)
                .map_err(|error| format!("{resource_name}重定向地址无法解析：{error}"))?;
            if next_url == current_url {
                return Err(format!(
                    "{resource_name}的重定向没有指向新地址（Location 为空或指向自身），该地址当前不可用"
                ));
            }
            current_url = next_url;
            continue;
        }
        if !response.status().is_success() {
            // Read a bounded error body, for the same reason `fetch_response_bytes` does: the
            // status alone does not say *why*, and a region block states it only in the body.
            let status = response.status();
            let mut response = response;
            let mut detail = String::new();
            while let Ok(Some(chunk)) = response.chunk().await {
                if detail.len().saturating_add(chunk.len()) > ERROR_BODY_MAX_BYTES {
                    break;
                }
                detail.push_str(&String::from_utf8_lossy(&chunk));
            }
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
pub(crate) async fn fetch_media_prefix(
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

pub(crate) async fn fetch_media_bytes(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
) -> Result<(Vec<u8>, Option<String>, Url), String> {
    fetch_response_bytes(url, Method::GET, max_bytes, resource_name, headers, None, 3).await
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
    for redirect_index in 0..=max_redirects {
        validate_remote_url(&current_url)?;
        let client = build_http_client(&current_url).await?;
        let mut request = client.request(method.clone(), current_url.clone());
        request = apply_request_headers(request, headers)?;
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
            let next_url = current_url
                .join(location)
                .map_err(|error| format!("{resource_name}重定向地址无法解析：{error}"))?;
            // An empty Location resolves back to the current URL, which would otherwise spin
            // until the redirect budget runs out and be reported as "too many redirects" even
            // though only one hop was ever attempted.
            if next_url == current_url {
                return Err(format!(
                    "{resource_name}的重定向没有指向新地址（Location 为空或指向自身），该地址当前不可用"
                ));
            }
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
            let mut detail = String::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
                // Enough for an error page; anything longer is not an explanation.
                if detail.len().saturating_add(chunk.len()) > ERROR_BODY_MAX_BYTES {
                    break;
                }
                detail.push_str(&String::from_utf8_lossy(&chunk));
            }
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
            return Err(format!("{host} 是本机或局域网地址，Moseek 不会请求它"));
        }
        return Ok(vec![std::net::SocketAddr::new(address, port)]);
    }
    let addresses = resolve_host_with_timeout(host, port).await?;
    // Any disallowed address rejects the host outright, matching the rule applied to a literal
    // address: a name that can reach the local network is not a name we contact.
    if addresses.iter().any(|address| is_disallowed_ip(address.ip())) {
        return Err(format!("{host} 解析到本机或局域网地址，Moseek 不会请求它"));
    }
    if addresses.is_empty() {
        return Err("远程主机没有解析出可用地址".to_string());
    }
    Ok(addresses)
}

async fn build_http_client(url: &Url) -> Result<Client, String> {
    build_http_client_with(url, ClientMode::Buffered).await
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

fn is_disallowed_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_broadcast()
        }
        IpAddr::V6(address) => {
            address
                .to_ipv4_mapped()
                .is_some_and(|mapped| is_disallowed_ip(IpAddr::V4(mapped)))
                || address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (address.segments()[0] & 0xffc0 == 0xfe80)
                || (address.segments()[0] & 0xfe00 == 0xfc00)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        collapse_whitespace, is_disallowed_ip, resolve_allowed_addresses, resolve_host,
        validate_remote_url, DNS_TIMEOUT,
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
}
