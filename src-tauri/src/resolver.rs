use std::{collections::HashMap, net::IpAddr, time::Duration, time::Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::future::{join_all, select_ok};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::policy::{
    fetch_media_bytes, fetch_media_prefix, fetch_text_following_redirects, fetch_text_with_headers,
    fetch_text_with_method, open_media_response, validate_remote_url,
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseServiceInput {
    pub key: String,
    pub url: String,
    #[serde(default = "default_get_method")]
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub capability: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackResolution {
    pub url: String,
    pub media_kind: String,
    pub adapter_id: String,
    pub parse_service_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResource {
    pub body_base64: String,
    pub content_type: Option<String>,
    pub url: String,
}

/// What container a media address actually serves.
///
/// `container` is decided from the bytes, not the label. Publishers mislabel Content-Type often
/// enough that this project already treats it as untrustworthy, and the address itself is worse
/// still: the FLV channel this was built for is `https://live.ottiptv.cc/douyu/431460`, which names
/// no extension at all and only reveals `video/x-flv` two redirects later.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaContainerProbe {
    /// `flv`, `mpegts`, `hls` or `unknown`.
    pub container: String,
    pub content_type: Option<String>,
    /// The address the probe finally landed on, after redirects.
    pub url: String,
    /// How many bytes the verdict was made from, so the UI can state its own confidence.
    pub probed_bytes: usize,
    pub message: String,
}

/// How much of a media address is read to identify its container.
///
/// An FLV header is 9 bytes plus the first tag, and an HLS playlist starts with `#EXTM3U`, so this
/// is two orders of magnitude more than the verdict needs. The size is chosen for what it avoids
/// rather than for what it reads: a live stream never ends, so a *buffered* read of this address
/// could only ever fail — measured, the 1 MiB budget reported "error decoding response body" after
/// 16 441 ms while the 512 KiB budget failed the same way after 5 630 ms. Reading a small window and
/// hanging up turns that into a single fast round trip (the first chunk of this stream arrived at
/// 1 244 ms).
const CONTAINER_PROBE_BYTES: usize = 64 * 1024;

/// Identifies the container behind a media address from its leading bytes.
///
/// Deliberately a pure function over bytes so it can be tested without a network.
fn classify_media_container(body: &[u8], content_type: Option<&str>) -> (String, String) {
    // FLV: `FLV` then a version byte then flags. The signature is exact and cannot be produced by
    // an HLS playlist or an MPEG-TS packet, so it is checked first and needs no corroboration.
    if body.len() >= 4 && &body[0..3] == b"FLV" {
        return (
            "flv".to_string(),
            format!("文件头为 FLV（{} 字节）", body.len()),
        );
    }
    // MPEG-TS: 188-byte packets each starting with the sync byte 0x47. One sync byte is a
    // coincidence; two in a row at the packet stride is the format.
    if body.len() >= 377 && body[0] == 0x47 && body[188] == 0x47 && body[376] == 0x47 {
        return ("mpegts".to_string(), "文件头为 MPEG-TS（188 字节包）".to_string());
    }
    // An HLS playlist is text and is unambiguous when present. A BOM is tolerated because
    // `isHlsPlaylist` on the player side tolerates one too.
    let text = body.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(body);
    if text.starts_with(b"#EXTM3U") {
        return ("hls".to_string(), "文件头为 #EXTM3U".to_string());
    }
    // A web page is worth naming separately: several IPTV addresses answer 200 with a landing page,
    // and "unknown" would leave the user with nothing to act on.
    let head = String::from_utf8_lossy(&body[..body.len().min(512)]);
    let trimmed = head.trim_start().to_ascii_lowercase();
    if trimmed.starts_with("<!doctype html") || trimmed.starts_with("<html") {
        return ("html".to_string(), "响应是一个网页而不是媒体流".to_string());
    }
    // Only now does the label get a say, and only as a tiebreak for a body that said nothing.
    let label = content_type.unwrap_or_default().to_ascii_lowercase();
    if label.contains("flv") {
        return (
            "flv".to_string(),
            format!("仅凭响应头 video/x-flv 判定（前 {} 字节无文件头）", body.len()),
        );
    }
    if label.contains("mpegurl") {
        return (
            "hls".to_string(),
            format!("仅凭响应头 {label} 判定（前 {} 字节无文件头）", body.len()),
        );
    }
    if label.starts_with("video/mp2t") {
        return ("mpegts".to_string(), "仅凭响应头 video/mp2t 判定".to_string());
    }
    (
        "unknown".to_string(),
        format!(
            "前 {} 字节无法识别容器（响应头 {}）",
            body.len(),
            content_type.unwrap_or("未知")
        ),
    )
}

/// Reads the first few bytes of a media address and reports what container they are.
///
/// This is the only reliable way to answer the question for an arbitrary IPTV address. The label is
/// not trustworthy (this project has already been burned by publishers mislabelling), and the URL
/// frequently carries no extension — the channel this exists for is a bare `/douyu/431460` that
/// 301-redirects to an FLV. The bytes cannot lie, and the redirect is followed here exactly as the
/// player would follow it, so the verdict describes what playback will actually receive.
#[tauri::command]
pub async fn probe_media_container(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<MediaContainerProbe, String> {
    let parsed_url = Url::parse(&url).map_err(|error| error.to_string())?;
    let header_pairs = headers
        .unwrap_or_default()
        .into_iter()
        .collect::<Vec<_>>();
    let (body, content_type, final_url) = fetch_media_prefix(
        parsed_url,
        CONTAINER_PROBE_BYTES,
        "媒体容器探测",
        &header_pairs,
    )
    .await?;
    let (container, message) = classify_media_container(&body, content_type.as_deref());
    Ok(MediaContainerProbe {
        container,
        content_type,
        url: final_url.to_string(),
        probed_bytes: body.len(),
        message,
    })
}

/// Live media streams currently open, so the frontend can stop one it no longer wants.
///
/// A live response never ends on its own, so a stream the user has navigated away from would keep
/// downloading until the process exits unless something cancels it. Keyed by an id the frontend
/// generates, because the frontend is the side that knows when playback has moved on.
#[derive(Default)]
pub struct MediaStreamRegistry(
    std::sync::Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
);

/// Streams a live media response to the frontend over a channel.
///
/// The buffered `fetch_media_resource` command cannot serve this: it reads a body to completion, and
/// a live HTTP-FLV body never completes. Measured on `https://live.ottiptv.cc/douyu/431460`, asking
/// it for 1 MiB returned "error decoding response body" after 16 441 ms — reqwest reports a
/// total-timeout hit during a body read as a *decode* error — even though the same response had
/// already delivered 267 280 bytes of healthy `video/x-flv`. The stream is therefore forwarded as it
/// arrives, under a per-read deadline instead of a total one.
///
/// The first message is always metadata, so the caller learns the final address and content type
/// before any media arrives.
#[tauri::command]
pub async fn stream_media_resource(
    stream_id: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    registry: tauri::State<'_, MediaStreamRegistry>,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tauri::ipc::InvokeResponseBody;

    let cancelled = Arc::new(AtomicBool::new(false));
    registry
        .0
        .lock()
        .map_err(|_| "媒体流注册表不可用".to_string())?
        .insert(stream_id.clone(), cancelled.clone());
    // The guard removes the entry on every exit path, including the early `?` returns below, so a
    // finished or failed stream cannot leave a stale id behind.
    let _guard = StreamRegistrationGuard {
        registry: &registry,
        stream_id: stream_id.clone(),
    };

    let parsed_url = Url::parse(&url).map_err(|error| error.to_string())?;
    let header_pairs = headers
        .unwrap_or_default()
        .into_iter()
        .collect::<Vec<_>>();
    let (mut response, final_url) = open_media_response(parsed_url, "媒体流", &header_pairs).await?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    channel
        .send(InvokeResponseBody::Json(
            serde_json::json!({
                "kind": "meta",
                "url": final_url.to_string(),
                "contentType": content_type,
            })
            .to_string(),
        ))
        .map_err(|error| format!("媒体流元数据发送失败：{error}"))?;

    while !cancelled.load(Ordering::Relaxed) {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if chunk.is_empty() {
                    continue;
                }
                if channel.send(InvokeResponseBody::Raw(chunk.to_vec())).is_err() {
                    // The webview dropped the channel, which means nothing is listening any more.
                    return Ok(());
                }
            }
            Ok(None) => return Ok(()),
            Err(error) => {
                if cancelled.load(Ordering::Relaxed) {
                    return Ok(());
                }
                return Err(format!("媒体流读取失败：{error}"));
            }
        }
    }
    Ok(())
}

/// Stops a stream started by [`stream_media_resource`].
///
/// Idempotent: cancelling an already-finished stream is an ordinary outcome, not an error, because
/// the frontend cannot know whether the upstream ended a moment before it stopped listening.
#[tauri::command]
pub fn cancel_media_stream(
    stream_id: String,
    registry: tauri::State<'_, MediaStreamRegistry>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let registry = registry
        .0
        .lock()
        .map_err(|_| "媒体流注册表不可用".to_string())?;
    if let Some(flag) = registry.get(&stream_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Removes a stream's registration however the streaming command exits.
struct StreamRegistrationGuard<'a> {
    registry: &'a tauri::State<'a, MediaStreamRegistry>,
    stream_id: String,
}

impl Drop for StreamRegistrationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.0.lock() {
            registry.remove(&self.stream_id);
        }
    }
}

/// One line's probe outcome. `ok` means the address really served a playable manifest, not
/// merely that it answered.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbe {
    pub index: usize,
    pub url: String,
    pub ok: bool,
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub media_kind: String,
    pub elapsed_ms: u64,
    pub message: String,
}

const PROBE_TIMEOUT_MS: u64 = 4_000;
/// Enough for a manifest; anything larger is not a playlist we can use.
const PROBE_MAX_BYTES: usize = 512 * 1024;
/// Bounds the fan-out so a playlist with hundreds of mirrors cannot open hundreds of sockets.
///
/// This was 12, which silently ignored every line past the twelfth. A channel carrying 16 lines
/// is ordinary for IPTV, so the probe reported "all lines failed" while never having looked at
/// four of them — and the caller had no way to tell. 32 covers realistic playlists while still
/// refusing to open a socket per entry in a list of hundreds.
const MAX_PROBE_URLS: usize = 32;

const DEFAULT_SNIFFER_COMPANION_URL: &str = "http://127.0.0.1:57573/sniffer";
const MAX_PARSE_REQUEST_BODY_BYTES: usize = 128 * 1024;
const MAX_MEDIA_RESOURCE_BYTES: usize = 16 * 1024 * 1024;
const MIN_MEDIA_RESOURCE_BYTES: usize = 64 * 1024;

#[tauri::command]
pub async fn fetch_media_resource(
    url: String,
    headers: HashMap<String, String>,
    max_bytes: Option<usize>,
) -> Result<MediaResource, String> {
    let parsed_url = Url::parse(&url).map_err(|error| error.to_string())?;
    let header_pairs = headers.into_iter().collect::<Vec<_>>();
    // The caller narrows the budget for playlist requests. A manifest is a few kilobytes, so
    // letting a non-HLS address stream megabytes into memory only delays the failure and
    // reports a size limit instead of "this is not a playlist".
    let limit = max_bytes
        .unwrap_or(MAX_MEDIA_RESOURCE_BYTES)
        .clamp(MIN_MEDIA_RESOURCE_BYTES, MAX_MEDIA_RESOURCE_BYTES);
    let (body, content_type, final_url) =
        fetch_media_bytes(parsed_url, limit, "媒体资源", &header_pairs).await?;
    Ok(MediaResource {
        body_base64: BASE64.encode(body),
        content_type,
        url: final_url.to_string(),
    })
}

/// How long one parser service may take.
///
/// The parser list in a real configuration is dozens of entries, and a dead host among them can
/// hang for the client's full 15-second timeout. Bounded well below that because a working parser
/// answers in well under a second, and the whole point of this budget is that one slow service
/// cannot hold the result.
const PARSE_SERVICE_TIMEOUT_MS: u64 = 6_000;

/// How long the player page may take to answer.
const PAGE_SCAN_TIMEOUT_MS: u64 = 10_000;

/// Enough for a player page: they are a few kilobytes of markup.
const PAGE_SCAN_MAX_BYTES: usize = 1024 * 1024;

/// How many parser services are attempted before giving up.
///
/// The configured list is ordered by the source author's preference, so the head of it is the part
/// worth trying. Bounded because the tail is where the dead hosts live: measured against the
/// author's 55 unique services, none of them resolved the address, and every one attempted costs a
/// request to a third party. This is also the fan-out cap — the attempts run as one concurrent
/// batch, so this many is the most sockets opened at once.
const MAX_PARSE_SERVICES: usize = 12;

/// Resolves an episode address into something the player can load.
///
/// Three steps, cheapest and most reliable first:
///
/// 1. An address that already names a media file is returned as-is.
/// 2. Otherwise the address may be a player page (`/share/<id>`, `/play/<id>`) with the manifest
///    written into its own markup. Scanning for it costs one request to the *source's own host*
///    and executes nothing — measured at 29 of 33 real page addresses.
/// 3. Only then are the configured parser services tried, concurrently and under a deadline.
///
/// Step 3 used to be the only step, and it is the one that produced "播放地址未通过安全检查": the
/// services are third-party endpoints with no obligation to answer, the loop was serial, and when
/// every one of them failed the caller was told the address had failed a security check.
///
/// `allow_page_scan` is opt-in because the live workspace shares this command. A live channel's
/// address routinely has no extension either, but it is a running stream rather than a page:
/// fetching a megabyte of it to look for markup would be waste, and the live path already probes
/// its lines properly.
#[tauri::command]
pub async fn resolve_playback(
    url: String,
    parse_services: Vec<ParseServiceInput>,
    allow_page_scan: Option<bool>,
) -> Result<PlaybackResolution, String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    validate_remote_url(&parsed_url)?;
    let direct_media_kind = media_kind(&url);
    if direct_media_kind != "unknown" {
        return Ok(PlaybackResolution {
            url,
            media_kind: direct_media_kind.to_string(),
            adapter_id: "direct-http".to_string(),
            parse_service_id: None,
        });
    }

    // The source's own player page. This is the common shape for ordinary CMS episodes, and it is
    // tried before any third party because the address is usually already on the page.
    if allow_page_scan.unwrap_or(false) {
        if let Some(resolution) = scan_episode_page(&parsed_url).await {
            return Ok(resolution);
        }
    }

    let candidates: Vec<ParseServiceInput> = parse_services
        .into_iter()
        .filter(is_usable_parse_service)
        .take(MAX_PARSE_SERVICES)
        .collect();

    // Nothing to try: hand the address back unchanged. Returning an error here would break every
    // extension-less address that has no parser behind it — which is exactly what a live channel
    // looks like, and the player is entitled to try it on its own.
    if candidates.is_empty() {
        return Ok(PlaybackResolution {
            url,
            media_kind: "unknown".to_string(),
            adapter_id: "direct-http".to_string(),
            parse_service_id: None,
        });
    }

    match resolve_with_services(&url, &candidates).await {
        Some(resolution) => Ok(resolution),
        None => Err(format!(
            "这个地址是播放页而不是视频文件，页面里没有可直接播放的地址；已尝试 {} 个解析服务，但没有一个返回可播放地址。请更换线路或影视源。",
            candidates.len()
        )),
    }
}

/// Whether a configured parser service can be attempted at all.
fn is_usable_parse_service(service: &ParseServiceInput) -> bool {
    service.enabled
        && service.capability == "supported"
        && is_supported_parser_method(&service.method)
}

/// Tries the parser services concurrently, returning the first success.
///
/// `select_ok` resolves as soon as one of them succeeds rather than waiting for the slowest, which
/// is the whole reason the services are fanned out. A service that fails or times out only removes
/// itself from the race.
async fn resolve_with_services(
    url: &str,
    services: &[ParseServiceInput],
) -> Option<PlaybackResolution> {
    let attempts = services.iter().cloned().map(|service| {
        Box::pin(async move {
            let resolved = tokio::time::timeout(
                Duration::from_millis(PARSE_SERVICE_TIMEOUT_MS),
                resolve_with_service(url, &service),
            )
            .await
            .map_err(|_| format!("解析服务「{}」超时", service.key))??;
            let resolved_url = reqwest::Url::parse(&resolved)
                .map_err(|error| format!("解析服务返回了无效地址：{error}"))?;
            validate_remote_url(&resolved_url)?;
            Ok::<PlaybackResolution, String>(PlaybackResolution {
                media_kind: media_kind(resolved_url.as_str()).to_string(),
                url: resolved_url.to_string(),
                adapter_id: "http-parser".to_string(),
                parse_service_id: Some(service.key.clone()),
            })
        })
    });
    select_ok(attempts).await.ok().map(|(resolution, _)| resolution)
}

/// Scans a player page for a media address it embeds.
///
/// Returns `None` for any reason at all — unreachable, not a page, no address in it — because this
/// is an optimisation on the way to the parser fallback, not a verdict about the address. Reporting
/// the first failure here would tell the user their source is broken when a parser might still
/// have resolved it.
async fn scan_episode_page(url: &Url) -> Option<PlaybackResolution> {
    let fetched = tokio::time::timeout(
        Duration::from_millis(PAGE_SCAN_TIMEOUT_MS),
        // Redirects are followed because this is predicting what the player would fetch, exactly
        // as the live channel probe does.
        fetch_text_following_redirects(url.clone(), PAGE_SCAN_MAX_BYTES, "播放页", 3),
    )
    .await
    .ok()?
    .ok()?;

    let media = crate::page_stream::media_urls_in_page(&fetched, url);
    let first = media.first()?;
    let resolved = reqwest::Url::parse(first).ok()?;
    validate_remote_url(&resolved).ok()?;
    Some(PlaybackResolution {
        media_kind: media_kind(resolved.as_str()).to_string(),
        url: resolved.to_string(),
        adapter_id: "page-scan".to_string(),
        parse_service_id: None,
    })
}


/// Probes several candidate stream URLs at once and reports which ones actually serve a
/// playable manifest, fastest first.
///
/// The workspace used to try lines strictly in order: line 1 was handed to the player, the
/// player spent its timeout failing, and only then was line 2 attempted. With several lines
/// that is a long serial wait, and the line that works is often not the first. Probing in
/// parallel costs one request per line but returns the usable ones in a single round trip.
#[tauri::command]
pub async fn probe_stream_urls(
    urls: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<Vec<StreamProbe>, String> {
    let timeout = timeout_ms.unwrap_or(PROBE_TIMEOUT_MS).clamp(500, 15_000);
    let pending = probe_targets(urls);
    // `join_all` polls every probe concurrently on the current runtime; the requests are
    // independent, so there is no reason to await them one at a time.
    let results = join_all(
        pending
            .into_iter()
            .map(|(index, url)| async move { probe_one(index, &url, timeout).await }),
    )
    .await;
    let mut probes = results;
    sort_probes(&mut probes);
    Ok(probes)
}

/// Selects which lines to probe, keeping each one's original index.
///
/// The index is what ties a result back to its position in the channel's line list, so dropping
/// it — rather than the cap itself — is what would make the UI label the wrong line.
fn probe_targets(urls: Vec<String>) -> Vec<(usize, String)> {
    urls.into_iter()
        .enumerate()
        .take(MAX_PROBE_URLS)
        .collect()
}

/// Orders probes so the caller can take the head of the list: reachable lines first, then the
/// quickest response, then the original order as a stable tiebreak.
fn sort_probes(probes: &mut [StreamProbe]) {
    probes.sort_by(|left, right| {
        right
            .ok
            .cmp(&left.ok)
            .then_with(|| left.elapsed_ms.cmp(&right.elapsed_ms))
            .then_with(|| left.index.cmp(&right.index))
    });
}

async fn probe_one(index: usize, url: &str, timeout_ms: u64) -> StreamProbe {
    let started = Instant::now();
    let mut probe = StreamProbe {
        index,
        url: url.to_string(),
        ok: false,
        status: None,
        content_type: None,
        media_kind: String::new(),
        elapsed_ms: 0,
        message: String::new(),
    };
    let parsed = match Url::parse(url) {
        Ok(parsed) => parsed,
        Err(error) => {
            probe.message = format!("地址无效：{error}");
            return probe;
        }
    };
    if let Err(error) = validate_remote_url(&parsed) {
        probe.message = error;
        return probe;
    }
    // A manifest is small; the cap keeps a mislabelled URL from streaming megabytes. The
    // overall deadline is the probe's own, not the shared 15s client timeout, so one slow line
    // cannot hold the whole comparison.
    let fetched = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        fetch_media_bytes(parsed, PROBE_MAX_BYTES, "直播线路探测", &[]),
    )
    .await;
    match fetched {
        Err(_) => {
            probe.elapsed_ms = started.elapsed().as_millis() as u64;
            probe.message = format!("探测超时（{} 毫秒）", timeout_ms);
        }
        Ok(Ok((body, content_type, final_url))) => {
            probe.elapsed_ms = started.elapsed().as_millis() as u64;
            probe.content_type = content_type;
            probe.status = Some(200);
            let text = String::from_utf8_lossy(&body);
            let looks_like_manifest = text.trim_start().starts_with("#EXTM3U");
            let kind = media_kind(final_url.as_str());
            probe.media_kind = kind.to_string();
            // A 200 alone is not enough: an expired line often answers with an HTML error page
            // or an empty body, which the player then fails on. Require a real manifest.
            if looks_like_manifest || kind == "hls" {
                probe.ok = true;
                probe.message = "可用".to_string();
            } else {
                probe.message = "响应不是有效的直播清单".to_string();
            }
        }
        Ok(Err(error)) => {
            probe.elapsed_ms = started.elapsed().as_millis() as u64;
            probe.message = error;
        }
    }
    probe
}

#[tauri::command]
pub async fn sniff_with_companion(
    target_url: String,
    companion_url: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<PlaybackResolution, String> {
    let target = Url::parse(&target_url).map_err(|error| error.to_string())?;
    validate_remote_url(&target)?;
    let companion = Url::parse(
        companion_url
            .as_deref()
            .unwrap_or(DEFAULT_SNIFFER_COMPANION_URL),
    )
    .map_err(|error| format!("本地嗅探伴侣地址无效：{error}"))?;
    validate_companion_url(&companion)?;
    let timeout = timeout_ms.unwrap_or(15_000).clamp(1_000, 60_000);
    let mut endpoint = companion;
    endpoint
        .query_pairs_mut()
        .append_pair("url", target.as_str())
        .append_pair("mode", "0")
        .append_pair("timeout", &timeout.to_string());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout + 1_000))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Moseek/0.1")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(endpoint)
        .send()
        .await
        .map_err(|error| format!("本地嗅探伴侣不可用：{error}"))?
        .error_for_status()
        .map_err(|error| format!("本地嗅探伴侣返回错误：{error}"))?;
    if response
        .content_length()
        .is_some_and(|size| size > 2 * 1024 * 1024)
    {
        return Err("本地嗅探伴侣响应超过 2 MB 限制".to_string());
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("读取本地嗅探结果失败：{error}"))?;
    if body.len() > 2 * 1024 * 1024 {
        return Err("本地嗅探伴侣响应超过 2 MB 限制".to_string());
    }
    let body =
        String::from_utf8(body.to_vec()).map_err(|_| "本地嗅探结果不是有效 UTF-8".to_string())?;
    let resolved_url = extract_resolved_url(&body)
        .ok_or_else(|| "本地嗅探伴侣未返回可识别的 HTTP 播放地址".to_string())?;
    let resolved =
        Url::parse(&resolved_url).map_err(|error| format!("本地嗅探结果地址无效：{error}"))?;
    validate_remote_url(&resolved)?;
    Ok(PlaybackResolution {
        url: resolved.to_string(),
        media_kind: media_kind(resolved.as_str()).to_string(),
        adapter_id: "local-sniffer".to_string(),
        parse_service_id: None,
    })
}

/// Builds the request address for one parser service.
///
/// A configured parser address is a **prefix**, not a base URL: TVBox concatenates the target
/// straight onto the end of it, which is why every real entry in a configuration ends in a bare
/// `?url=` (or `?v=`). Appending a second `url=` parameter instead — which is what
/// `query_pairs_mut().append_pair` does — produced `…yun.php?url=&url=https%3A%2F%2F…`.
///
/// That is worse than cosmetic. A service reading `$_GET['url']` receives the **empty** first
/// value and has nothing to parse, and a service whose parameter is named `v` receives no `v` at
/// all. So the parameter is filled in place when the template already declares one, and appended
/// only when it declares none.
fn build_parser_request(service_url: &str, source_url: &str) -> Result<Url, String> {
    let endpoint = Url::parse(service_url).map_err(|error| error.to_string())?;
    validate_remote_url(&endpoint)?;
    let mut url = endpoint;
    match parser_parameter_name(url.query()) {
        Some(name) => {
            // Replace the trailing empty value rather than adding a second one.
            let filled = replace_query_parameter(url.query().unwrap_or_default(), &name, source_url);
            url.set_query(Some(&filled));
        }
        None => {
            url.query_pairs_mut().append_pair("url", source_url);
        }
    }
    Ok(url)
}

/// The query parameter an empty-valued parser template is meant to receive the target in.
///
/// The first parameter with an empty value is the placeholder: that is the shape every real
/// configuration uses, and it is the only reading that explains a trailing `?url=`. Returns `None`
/// when every parameter already carries a value, in which case appending is correct.
fn parser_parameter_name(query: Option<&str>) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let name = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default();
        if !name.is_empty() && value.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

/// Rewrites one query parameter's value, preserving the order and every other parameter.
fn replace_query_parameter(query: &str, name: &str, value: &str) -> String {
    let encoded = url_encode(value);
    let mut replaced = false;
    let parts: Vec<String> = query
        .split('&')
        .map(|pair| {
            let mut halves = pair.splitn(2, '=');
            let key = halves.next().unwrap_or_default();
            if !replaced && key == name {
                replaced = true;
                format!("{key}={encoded}")
            } else {
                pair.to_string()
            }
        })
        .collect();
    parts.join("&")
}

/// Percent-encodes a value for a query string.
///
/// Written out rather than pulled from a dependency because the required alphabet is tiny and
/// getting it wrong corrupts the target address silently. Everything outside the unreserved set is
/// escaped, which is correct for a value that is itself a URL.
fn url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

async fn resolve_with_service(
    source_url: &str,
    service: &ParseServiceInput,
) -> Result<String, String> {
    let method = service.method.to_ascii_uppercase();
    let mut headers = service
        .headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<Vec<_>>();
    // POST carries the target in the body, GET in the address, so only the GET path builds a
    // request URL out of the template.
    let endpoint = reqwest::Url::parse(&service.url).map_err(|error| error.to_string())?;
    validate_remote_url(&endpoint)?;
    let endpoint = if method == "GET" {
        build_parser_request(&service.url, source_url)?
    } else {
        endpoint
    };
    let body = if method == "GET" {
        None
    } else if method == "POST" {
        let mut object = service
            .body
            .clone()
            .unwrap_or_else(|| serde_json::json!({}))
            .as_object()
            .cloned()
            .ok_or_else(|| "POST 解析服务 body 必须是 JSON 对象".to_string())?;
        object
            .entry("url".to_string())
            .or_insert_with(|| Value::String(source_url.to_string()));
        if !headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        {
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
        }
        Some(
            serde_json::to_vec(&Value::Object(object))
                .map_err(|error| format!("POST 解析请求编码失败：{error}"))?,
        )
    } else {
        return Err("解析服务只支持 GET 或 POST 方法".to_string());
    };
    let body = body.filter(|body| body.len() <= MAX_PARSE_REQUEST_BODY_BYTES);
    if method == "POST" && body.is_none() {
        return Err("POST 解析请求体超过 128 KiB 限制".to_string());
    }
    let response = if method == "POST" {
        fetch_text_with_method(
            endpoint,
            reqwest::Method::POST,
            2 * 1024 * 1024,
            "解析服务响应",
            &headers,
            body,
        )
        .await?
    } else {
        fetch_text_with_headers(endpoint, 2 * 1024 * 1024, "解析服务响应", &headers).await?
    };
    extract_resolved_url(&response).ok_or_else(|| "解析服务未返回可播放 HTTP 地址".to_string())
}

fn default_get_method() -> String {
    "GET".to_string()
}

fn is_supported_parser_method(method: &str) -> bool {
    method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("POST")
}

fn extract_resolved_url(text: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        if let Some(url) = value_url(&value) {
            return Some(url);
        }
    }
    text.lines()
        .map(str::trim)
        .find(|line| line.starts_with("http://") || line.starts_with("https://"))
        .map(ToOwned::to_owned)
}

fn value_url(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if text.starts_with("http://") || text.starts_with("https://") => {
            Some(text.trim().to_string())
        }
        Value::Object(object) => ["url", "playUrl", "play_url", "link", "result", "data"]
            .iter()
            .find_map(|key| object.get(*key).and_then(value_url)),
        Value::Array(items) => items.iter().find_map(value_url),
        _ => None,
    }
}

fn media_kind(url: &str) -> &'static str {
    let lower_url = url.to_ascii_lowercase();
    if lower_url.contains(".m3u8") {
        "hls"
    } else if lower_url.contains(".mp4") {
        "mp4"
    } else {
        "unknown"
    }
}

fn validate_companion_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("本地嗅探伴侣只允许 HTTP 或 HTTPS 地址".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "本地嗅探伴侣地址缺少主机名".to_string())?;
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    let is_loopback = normalized == "localhost"
        || normalized == "::1"
        || normalized
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false);
    if !is_loopback {
        return Err("本地嗅探伴侣只允许配置在 localhost 或回环 IP 上".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        build_parser_request, classify_media_container, is_supported_parser_method, media_kind,
        parser_parameter_name, url_encode, validate_companion_url, value_url, MAX_PARSE_SERVICES,
    };

    #[test]
    fn extracts_common_parser_response_shapes() {
        assert_eq!(
            value_url(&json!({"data": {"url": "https://example.com/a.m3u8"}})),
            Some("https://example.com/a.m3u8".to_string())
        );
        assert_eq!(media_kind("https://example.com/a.mp4"), "mp4");
    }

    /// Every real parser address in a configuration is a prefix ending in a bare `url=`. Reading it
    /// as a base URL and appending a second parameter made the request
    /// `…yun.php?url=&url=https%3A%2F%2F…`, so a service reading `$_GET['url']` got the empty first
    /// value and had nothing to parse.
    #[test]
    fn a_parser_template_gets_its_own_parameter_filled_not_a_second_one() {
        let built = build_parser_request(
            "http://119.91.123.253:2345/Api/yun.php?url=",
            "https://vip.lz-cdn11.com/share/abc",
        )
        .expect("a public template builds");

        assert_eq!(
            built.as_str(),
            "http://119.91.123.253:2345/Api/yun.php?url=https%3A%2F%2Fvip.lz-cdn11.com%2Fshare%2Fabc"
        );
        // Exactly one `url`, and it carries the target rather than being empty.
        let values: Vec<String> = built
            .query_pairs()
            .filter(|(key, _)| key == "url")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(
            values,
            vec!["https://vip.lz-cdn11.com/share/abc".to_string()]
        );
    }

    /// A template whose parameter is not called `url` must still be filled in place — one real
    /// service uses `?v=`, and appending `url=` left it with no `v` at all.
    #[test]
    fn a_template_with_a_differently_named_parameter_is_still_filled() {
        let built = build_parser_request(
            "https://huayong.net/999/?v=",
            "https://cdn.example/a.m3u8",
        )
        .expect("a public template builds");
        assert_eq!(
            built.as_str(),
            "https://huayong.net/999/?v=https%3A%2F%2Fcdn.example%2Fa.m3u8"
        );
        assert_eq!(built.query_pairs().count(), 1);
    }

    /// Parameters that already carry values are kept, and only the empty one is filled.
    #[test]
    fn existing_parameters_survive_and_the_empty_one_is_filled() {
        let built = build_parser_request(
            "https://vip.example.com:443/api/?key=q7mS&url=",
            "https://cdn.example/a.m3u8",
        )
        .expect("a public template builds");
        let pairs: Vec<(String, String)> = built
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("key".to_string(), "q7mS".to_string()),
                ("url".to_string(), "https://cdn.example/a.m3u8".to_string()),
            ]
        );
    }

    /// A template that declares no placeholder at all gets the target appended, because there is
    /// nowhere else to put it.
    #[test]
    fn a_template_without_a_placeholder_gets_the_parameter_appended() {
        let built = build_parser_request("https://jx.example.com/parse", "https://cdn.example/a")
            .expect("a public template builds");
        assert_eq!(
            built.as_str(),
            "https://jx.example.com/parse?url=https%3A%2F%2Fcdn.example%2Fa"
        );
    }

    /// The placeholder is the first empty-valued parameter, not simply the first one.
    #[test]
    fn the_placeholder_is_the_first_empty_parameter() {
        assert_eq!(
            parser_parameter_name(Some("key=abc&url=")),
            Some("url".to_string())
        );
        assert_eq!(parser_parameter_name(Some("v=")), Some("v".to_string()));
        assert_eq!(parser_parameter_name(Some("key=abc")), None);
        assert_eq!(parser_parameter_name(None), None);
        assert_eq!(parser_parameter_name(Some("")), None);
    }

    /// Encoding must escape the delimiters inside a URL, or the target's own query string would
    /// split the parser request.
    #[test]
    fn a_target_url_is_percent_encoded_as_one_value() {
        assert_eq!(
            url_encode("https://cdn.example/a.m3u8?sign=b1&x=2"),
            "https%3A%2F%2Fcdn.example%2Fa.m3u8%3Fsign%3Db1%26x%3D2"
        );
        // Unreserved characters stay literal.
        assert_eq!(url_encode("aZ0-._~"), "aZ0-._~");
    }

    /// A parser URL is a prefix, so a local one must be refused before it is contacted.
    #[test]
    fn a_local_parser_template_is_refused() {
        assert!(build_parser_request("http://127.0.0.1:9978/proxy?url=", "https://a.example/x").is_err());
    }

    /// The service list in a real configuration is dozens of entries, most of them dead. Only the
    /// head is attempted, so one dead host cannot hold the whole result.
    #[test]
    fn only_the_head_of_the_parser_list_is_attempted() {
        let services: Vec<super::ParseServiceInput> = (0..50)
            .map(|index| super::ParseServiceInput {
                key: format!("parse-{index}"),
                url: format!("https://parser{index}.example.com/?url="),
                method: "GET".to_string(),
                headers: Default::default(),
                body: None,
                enabled: true,
                capability: "supported".to_string(),
            })
            .collect();
        assert_eq!(services.len(), 50, "the fixture must exceed the cap");
        let attempted: Vec<_> = services
            .into_iter()
            .filter(super::is_usable_parse_service)
            .take(MAX_PARSE_SERVICES)
            .collect();
        assert_eq!(attempted.len(), MAX_PARSE_SERVICES);
    }

    /// Only enabled, supported, GET/POST services are attempted.
    #[test]
    fn unusable_parser_services_are_skipped() {
        let make = |enabled: bool, capability: &str, method: &str| super::ParseServiceInput {
            key: "k".to_string(),
            url: "https://parser.example.com/?url=".to_string(),
            method: method.to_string(),
            headers: Default::default(),
            body: None,
            enabled,
            capability: capability.to_string(),
        };
        assert!(super::is_usable_parse_service(&make(true, "supported", "GET")));
        assert!(super::is_usable_parse_service(&make(true, "supported", "post")));
        assert!(!super::is_usable_parse_service(&make(false, "supported", "GET")));
        assert!(!super::is_usable_parse_service(&make(true, "blocked", "GET")));
        assert!(!super::is_usable_parse_service(&make(true, "supported", "PUT")));
    }

    #[test]
    fn companion_policy_only_allows_loopback_hosts() {
        assert!(validate_companion_url(&"http://127.0.0.1:57573/sniffer".parse().unwrap()).is_ok());
        assert!(validate_companion_url(&"http://localhost:57573/sniffer".parse().unwrap()).is_ok());
        assert!(validate_companion_url(&"https://example.com/sniffer".parse().unwrap()).is_err());
    }

    #[test]
    fn parser_supports_only_safe_get_and_post_methods() {
        assert!(is_supported_parser_method("GET"));
        assert!(is_supported_parser_method("post"));
        assert!(!is_supported_parser_method("PUT"));
    }

    fn probe(index: usize, ok: bool, elapsed_ms: u64) -> super::StreamProbe {
        super::StreamProbe {
            index,
            url: format!("https://stream.example/line-{index}.m3u8"),
            ok,
            status: None,
            content_type: None,
            media_kind: "hls".to_string(),
            elapsed_ms,
            message: String::new(),
        }
    }

    /// The caller takes the head of the list, so reachable lines must come first and the
    /// quickest of those must lead — otherwise probing in parallel would still hand the player
    /// a dead line.
    #[test]
    fn probe_results_lead_with_the_fastest_reachable_line() {
        let mut probes = vec![
            probe(0, false, 10),
            probe(1, true, 250),
            probe(2, true, 90),
            probe(3, false, 5),
        ];
        super::sort_probes(&mut probes);

        assert_eq!(probes[0].index, 2, "fastest reachable line should lead");
        assert_eq!(probes[1].index, 1);
        // Unreachable lines sink to the bottom, even though one answered quickly.
        assert!(!probes[2].ok);
        assert!(!probes[3].ok);
    }

    #[test]
    fn probe_ordering_is_stable_for_equal_timings() {
        let mut probes = vec![probe(2, true, 100), probe(0, true, 100), probe(1, true, 100)];
        super::sort_probes(&mut probes);

        assert_eq!(
            probes.iter().map(|item| item.index).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    /// A 16-line channel is ordinary for IPTV. The cap used to be 12, so four lines were never
    /// looked at while the caller was told every line had failed.
    #[test]
    fn probes_every_line_of_a_sixteen_line_channel() {
        let urls: Vec<String> = (0..16)
            .map(|index| format!("https://stream.example/line-{index}.m3u8"))
            .collect();
        let targets = super::probe_targets(urls);
        assert_eq!(targets.len(), 16);
        // Indices must survive, because they map results back to the UI's line buttons.
        assert_eq!(targets[15].0, 15);
    }

    #[test]
    fn still_bounds_a_pathological_line_list() {
        let urls: Vec<String> = (0..500)
            .map(|index| format!("https://stream.example/line-{index}.m3u8"))
            .collect();
        let targets = super::probe_targets(urls);
        assert_eq!(targets.len(), super::MAX_PROBE_URLS);
    }

    /// The page scan, against the real pages the author's sources return.
    ///
    /// Ignored by default because it needs the network, and a third-party page going away must not
    /// fail a build. Run it with `cargo test -- --ignored` when the scan is suspected of having
    /// stopped matching reality — the shapes it depends on are other people's markup, so this is
    /// the only test that can notice them changing.
    /// The container verdict must come from the bytes, because neither the address nor the label can
    /// be trusted. The channel this was written for is `https://live.ottiptv.cc/douyu/431460`: the
    /// address names no extension and 301-redirects to an FLV, and the mislabelling problem is
    /// already established in this project.
    #[test]
    fn a_container_is_identified_from_its_leading_bytes() {
        // A real FLV header, captured from the live channel this was diagnosed on.
        let mut flv = b"FLV\x01\x05\x00\x00\x00\x09".to_vec();
        flv.extend_from_slice(&[0u8; 32]);
        assert_eq!(classify_media_container(&flv, Some("video/x-flv")).0, "flv");

        // The bytes outrank a wrong label in both directions.
        assert_eq!(
            classify_media_container(&flv, Some("application/octet-stream")).0,
            "flv"
        );
        assert_eq!(
            classify_media_container(b"#EXTM3U\n#EXT-X-VERSION:3\n", Some("video/x-flv")).0,
            "hls"
        );
        // A BOM before the playlist is tolerated, matching the player's own playlist check.
        assert_eq!(
            classify_media_container(b"\xEF\xBB\xBF#EXTM3U\n", None).0,
            "hls"
        );
    }

    #[test]
    fn mpeg_ts_is_recognised_by_its_packet_stride() {
        // 188-byte packets, each beginning with the sync byte.
        let mut ts = vec![0u8; 188 * 3];
        ts[0] = 0x47;
        ts[188] = 0x47;
        ts[376] = 0x47;
        assert_eq!(classify_media_container(&ts, None).0, "mpegts");
        // A single sync byte is a coincidence, not the format.
        let mut stray = vec![0u8; 188 * 3];
        stray[0] = 0x47;
        assert_eq!(classify_media_container(&stray, None).0, "unknown");
    }

    #[test]
    fn a_landing_page_is_named_rather_than_reported_as_unknown() {
        // Several IPTV addresses answer 200 with a web page. "unknown" would leave the user with
        // nothing to act on.
        let page = b"<!DOCTYPE html><html><head><title>Not found</title></head></html>";
        let (container, message) = classify_media_container(page, Some("text/html"));
        assert_eq!(container, "html");
        assert!(message.contains("网页"), "{message}");
    }

    /// The label is only a tiebreak for a body that said nothing itself, and the verdict has to say
    /// when that is all it had to go on.
    #[test]
    fn the_content_type_is_used_only_when_the_bytes_say_nothing() {
        let opaque = vec![0u8; 64];
        let (container, message) = classify_media_container(&opaque, Some("video/x-flv"));
        assert_eq!(container, "flv");
        assert!(message.contains("仅凭响应头"), "{message}");

        let (container, message) = classify_media_container(&opaque, Some("application/json"));
        assert_eq!(container, "unknown");
        assert!(message.contains("application/json"), "{message}");
    }

    /// An empty or truncated body must not panic — the probe reads a bounded window and a dead
    /// upstream can return nothing at all.
    #[test]
    fn a_short_body_is_handled_without_panicking() {
        assert_eq!(classify_media_container(b"", None).0, "unknown");
        assert_eq!(classify_media_container(b"FL", None).0, "unknown");
        assert_eq!(classify_media_container(b"FLV", None).0, "unknown");
    }

    /// The container probe, against the real channel it was written for.
    ///
    /// Ignored by default because it needs the network. Run it with `cargo test -- --ignored` when
    /// the verdict is suspected of having stopped matching reality — the address redirects through
    /// someone else's CDN, so this is the only test that can notice that changing.
    #[test]
    #[ignore]
    fn the_real_flv_channel_is_identified_as_flv() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let url = reqwest::Url::parse("https://live.ottiptv.cc/douyu/431460").unwrap();
            let started = std::time::Instant::now();
            let (body, content_type, final_url) =
                crate::policy::fetch_media_prefix(
                    url,
                    super::CONTAINER_PROBE_BYTES,
                    "媒体容器探测",
                    &[],
                )
                .await
                .expect("the live channel answers");
            let (container, message) = classify_media_container(&body, content_type.as_deref());
            println!(
                "container={container} bytes={} ct={content_type:?} elapsed={}ms\n  {message}\n  final={final_url}",
                body.len(),
                started.elapsed().as_millis()
            );
            assert_eq!(container, "flv");
            assert_eq!(&body[0..3], b"FLV");
        });
    }

    #[test]
    #[ignore]
    fn the_real_share_pages_still_yield_a_manifest() {
        let cases = [
            // A relative address in a `var` assignment.
            "https://vip.lz-cdn11.com/share/0c72cb7ee1512f800abe27823a792d03",
            // An absolute address in a `const`, served by a different source family.
            "https://play.hhuus.com/play/epYkgmma",
        ];
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            for case in cases {
                let url = reqwest::Url::parse(case).unwrap();
                let resolution = super::scan_episode_page(&url)
                    .await
                    .unwrap_or_else(|| panic!("{case} yielded no playable address"));
                assert_eq!(resolution.adapter_id, "page-scan");
                assert_eq!(resolution.media_kind, "hls", "{case}");
                assert!(
                    resolution.url.contains(".m3u8"),
                    "{case} resolved to {}",
                    resolution.url
                );
                println!("{case}\n  -> {}", resolution.url);
            }
        });
    }
}
