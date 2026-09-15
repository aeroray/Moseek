use std::{collections::HashMap, net::IpAddr, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::policy::{
    fetch_media_bytes, fetch_text_with_headers, fetch_text_with_method, validate_remote_url,
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

#[tauri::command]
pub async fn resolve_playback(
    url: String,
    parse_services: Vec<ParseServiceInput>,
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

    let mut attempted_service = false;
    let mut last_error = None;
    for service in parse_services {
        if !service.enabled
            || service.capability != "supported"
            || !is_supported_parser_method(&service.method)
        {
            continue;
        }
        attempted_service = true;
        let service_result = resolve_with_service(&url, &service).await;
        match service_result {
            Ok(resolved_url) => {
                let resolved_url = reqwest::Url::parse(&resolved_url)
                    .map_err(|error| format!("解析服务返回了无效地址：{error}"))?;
                validate_remote_url(&resolved_url)?;
                return Ok(PlaybackResolution {
                    media_kind: media_kind(resolved_url.as_str()).to_string(),
                    url: resolved_url.to_string(),
                    adapter_id: "http-parser".to_string(),
                    parse_service_id: Some(service.key),
                });
            }
            Err(error) => last_error = Some(error),
        }
    }

    if attempted_service {
        return Err(last_error.unwrap_or_else(|| "解析服务未返回可播放地址".to_string()));
    }

    Ok(PlaybackResolution {
        url,
        media_kind: "unknown".to_string(),
        adapter_id: "direct-http".to_string(),
        parse_service_id: None,
    })
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

async fn resolve_with_service(
    source_url: &str,
    service: &ParseServiceInput,
) -> Result<String, String> {
    let mut endpoint = reqwest::Url::parse(&service.url).map_err(|error| error.to_string())?;
    validate_remote_url(&endpoint)?;
    let method = service.method.to_ascii_uppercase();
    let mut headers = service
        .headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<Vec<_>>();
    let body = if method == "GET" {
        endpoint.query_pairs_mut().append_pair("url", source_url);
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

    use super::{is_supported_parser_method, media_kind, validate_companion_url, value_url};

    #[test]
    fn extracts_common_parser_response_shapes() {
        assert_eq!(
            value_url(&json!({"data": {"url": "https://example.com/a.m3u8"}})),
            Some("https://example.com/a.m3u8".to_string())
        );
        assert_eq!(media_kind("https://example.com/a.mp4"), "mp4");
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
}
