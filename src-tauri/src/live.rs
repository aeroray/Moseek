use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;
use serde_json::Value;

use crate::{
    adapters::is_fetchable_live_url,
    cms::SourceTestResult,
    policy::{fetch_text, fetch_text_following_redirects, validate_remote_url},
    SourceOperationResult, SourceRecord,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveGroup {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChannel {
    pub id: String,
    pub name: String,
    pub group_id: String,
    pub group_name: String,
    pub logo_url: String,
    pub stream_url: String,
    pub stream_urls: Vec<String>,
    pub media_kind: String,
    pub source_key: String,
    pub epg_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCatalog {
    pub channels: Vec<LiveChannel>,
    pub groups: Vec<LiveGroup>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgProgram {
    pub id: String,
    pub channel_id: String,
    pub title: String,
    pub description: String,
    pub start_at: String,
    pub end_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgCatalog {
    pub programs: Vec<EpgProgram>,
}

#[tauri::command]
pub async fn load_live_source(source: SourceRecord) -> Result<LiveCatalog, String> {
    if source.source_type != "live" {
        return Err("该源不是直播适配器支持的 live 类型。".to_string());
    }
    // Derived from the address rather than from the stored `capability`, which the parser writes at
    // import time and never revisits. See `SiteAdapterKind::ensure_executable`.
    if !is_fetchable_live_url(&source.api) {
        return Err("该直播源的地址不是可请求的 HTTP 地址，当前不会执行。".to_string());
    }
    let source_key = source.key;
    let source_url = source.api;
    let format = source.ext.unwrap_or_else(|| "auto".to_string());
    let url = reqwest::Url::parse(&source_url).map_err(|error| error.to_string())?;
    let format = format.to_ascii_lowercase();
    let text = fetch_text(url, 20 * 1024 * 1024, "直播源响应").await?;
    let parsed_channels = if format == "json"
        || text.trim_start().starts_with('{')
        || text.trim_start().starts_with('[')
    {
        parse_json(&text, &source_key)?
    } else if format == "m3u"
        || text
            .lines()
            .any(|line| line.trim_start().starts_with("#EXTINF"))
    {
        parse_m3u(&text, &source_key)
    } else {
        parse_txt(&text, &source_key)
    };
    let channels = deduplicate_channels(parsed_channels);
    let groups = collect_groups(&channels);
    Ok(LiveCatalog { channels, groups })
}

const CHANNEL_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const CHANNEL_PROBE_MAX_BYTES: usize = 512 * 1024;

/// Requests one channel's manifest so a source test can tell "the playlist parses" apart
/// from "the playlist actually plays". Fetching the catalog only proves the list itself
/// is reachable: in public IPTV lists individual channels are routinely dead,
/// carrier-locked, or serving an HTML error page instead of HLS, and that is only
/// visible by asking for one of them. The probe is bounded so a silent host cannot make
/// the test hang, and it deliberately stays outside the catalog fetch so a failing
/// sample never hides a successfully parsed list.
async fn probe_channel_manifest(channel: &LiveChannel) -> Result<(), String> {
    let url = reqwest::Url::parse(&channel.stream_url).map_err(|error| error.to_string())?;
    let fetch = fetch_text_following_redirects(url, CHANNEL_PROBE_MAX_BYTES, "频道清单", 3);
    let text = tokio::time::timeout(CHANNEL_PROBE_TIMEOUT, fetch)
        .await
        .map_err(|_| format!("请求超过 {} 秒未返回", CHANNEL_PROBE_TIMEOUT.as_secs()))??;
    if !is_hls_manifest(&text) {
        return Err("返回的内容不是 HLS 清单，该地址可能已失效或返回了错误页".to_string());
    }
    Ok(())
}

/// Some upstreams serve the manifest with a UTF-8 BOM, which `trim_start` alone does not
/// remove because U+FEFF is a format character rather than whitespace.
fn is_hls_manifest(text: &str) -> bool {
    text.trim_start_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
        .starts_with("#EXTM3U")
}

/// The outer bound on a live test, matching the CMS one: a live source is fetched over HTTP, and
/// a host that accepts a connection then stalls would otherwise leave the UI on "测速中".
const LIVE_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

#[tauri::command]
pub async fn test_live_source(source: SourceRecord) -> Result<SourceTestResult, String> {
    let source_key = source.key.clone();
    let started = Instant::now();
    let tested_at = "刚刚".to_string();
    match tokio::time::timeout(LIVE_TEST_TIMEOUT, test_live_source_inner(source)).await {
        Ok(result) => result,
        Err(_) => Ok(SourceTestResult {
            source_key,
            status: "failed".to_string(),
            adapter_id: "builtin-live".to_string(),
            message: format!(
                "测试超时（{} 秒），已停止等待。该源可能无法访问或响应过慢。",
                LIVE_TEST_TIMEOUT.as_secs()
            ),
            item_count: 0,
            category_count: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            tested_at,
            operations: vec![SourceOperationResult {
                operation: "catalog".to_string(),
                status: "failed".to_string(),
                message: "测试超时。".to_string(),
                duration_ms: started.elapsed().as_millis() as u64,
            }],
        }),
    }
}

async fn test_live_source_inner(source: SourceRecord) -> Result<SourceTestResult, String> {
    let source_key = source.key.clone();
    let started = Instant::now();
    let tested_at = "刚刚".to_string();
    if source.source_type != "live" || !is_fetchable_live_url(&source.api) {
        return Ok(SourceTestResult {
            source_key,
            status: "blocked".to_string(),
            adapter_id: "builtin-live".to_string(),
            message: "该源的地址不是可请求的 HTTP 地址，无法测试。".to_string(),
            item_count: 0,
            category_count: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            tested_at,
            operations: vec![SourceOperationResult {
                operation: "catalog".to_string(),
                status: "blocked".to_string(),
                message: "该源的地址不是可请求的 HTTP 地址，无法测试。".to_string(),
                duration_ms: started.elapsed().as_millis() as u64,
            }],
        });
    }

    match load_live_source(source.clone()).await {
        Ok(catalog) => {
            let item_count = catalog.channels.len() as u64;
            let category_count = catalog.groups.len() as u64;
            let (status, message) = if item_count > 0 {
                (
                    "passed",
                    format!("请求成功，识别到 {item_count} 个频道和 {category_count} 个分组。"),
                )
            } else {
                (
                    "empty",
                    "请求成功，但响应中没有可识别的直播频道。".to_string(),
                )
            };
            let mut operations = vec![SourceOperationResult {
                operation: "catalog".to_string(),
                status: status.to_string(),
                message: message.clone(),
                duration_ms: started.elapsed().as_millis() as u64,
            }];
            let playback_operation = match catalog.channels.first() {
                Some(channel) => {
                    let probe_started = Instant::now();
                    let outcome = probe_channel_manifest(channel).await;
                    let duration_ms = probe_started.elapsed().as_millis() as u64;
                    match outcome {
                        Ok(()) => SourceOperationResult {
                            operation: "playback".to_string(),
                            status: "passed".to_string(),
                            message: format!(
                                "首个频道「{}」返回了可用的 HLS 清单（仅抽样 1 个频道）。",
                                channel.name
                            ),
                            duration_ms,
                        },
                        Err(error) => SourceOperationResult {
                            operation: "playback".to_string(),
                            status: "failed".to_string(),
                            message: format!(
                                "首个频道「{}」无法播放：{error}。频道目录可用，但列表中的地址可能已失效或只对特定网络开放。",
                                channel.name
                            ),
                            duration_ms,
                        },
                    }
                }
                None => SourceOperationResult {
                    operation: "playback".to_string(),
                    status: "empty".to_string(),
                    message: "没有可用于播放探测的频道。".to_string(),
                    duration_ms: 0,
                },
            };
            let playback_failed = playback_operation.status == "failed";
            operations.push(playback_operation);
            let message = if playback_failed {
                format!("{message} 首个频道当前无法播放，实际可用频道数可能少于目录数量。")
            } else {
                message
            };
            let epg_operation = if let Some(epg_url) = source.epg.clone() {
                let epg_started = Instant::now();
                match get_epg(epg_url, "auto".to_string()).await {
                    Ok(epg) if !epg.programs.is_empty() => SourceOperationResult {
                        operation: "epg".to_string(),
                        status: "passed".to_string(),
                        message: format!("识别到 {} 条节目单。", epg.programs.len()),
                        duration_ms: epg_started.elapsed().as_millis() as u64,
                    },
                    Ok(_) => SourceOperationResult {
                        operation: "epg".to_string(),
                        status: "empty".to_string(),
                        message: "EPG 请求成功，但没有节目单数据。".to_string(),
                        duration_ms: epg_started.elapsed().as_millis() as u64,
                    },
                    Err(error) => SourceOperationResult {
                        operation: "epg".to_string(),
                        status: "failed".to_string(),
                        message: error,
                        duration_ms: epg_started.elapsed().as_millis() as u64,
                    },
                }
            } else {
                SourceOperationResult {
                    operation: "epg".to_string(),
                    status: "skipped".to_string(),
                    message: "源没有配置 EPG 地址。".to_string(),
                    duration_ms: 0,
                }
            };
            operations.push(epg_operation);
            Ok(SourceTestResult {
                source_key,
                status: status.to_string(),
                adapter_id: "builtin-live".to_string(),
                message: message.clone(),
                item_count,
                category_count,
                duration_ms: started.elapsed().as_millis() as u64,
                tested_at,
                operations,
            })
        }
        Err(error) => {
            let message = error;
            Ok(SourceTestResult {
                source_key,
                status: "failed".to_string(),
                adapter_id: "builtin-live".to_string(),
                message: message.clone(),
                item_count: 0,
                category_count: 0,
                duration_ms: started.elapsed().as_millis() as u64,
                tested_at,
                operations: vec![SourceOperationResult {
                    operation: "catalog".to_string(),
                    status: "failed".to_string(),
                    message,
                    duration_ms: started.elapsed().as_millis() as u64,
                }],
            })
        }
    }
}

#[tauri::command]
pub async fn get_epg(source_url: String, format: String) -> Result<EpgCatalog, String> {
    let url = reqwest::Url::parse(&source_url).map_err(|error| error.to_string())?;
    let text = fetch_text(url, 20 * 1024 * 1024, "EPG 响应").await?;
    let normalized_format = format.to_ascii_lowercase();
    let programs = if normalized_format == "json"
        || text.trim_start().starts_with('{')
        || text.trim_start().starts_with('[')
    {
        parse_epg_json(&text)?
    } else {
        parse_xmltv(&text)?
    };
    Ok(EpgCatalog { programs })
}

fn parse_xmltv(text: &str) -> Result<Vec<EpgProgram>, String> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut current: Option<XmlProgram> = None;
    let mut current_field: Option<&'static str> = None;
    let mut programs = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) if event.name().as_ref() == b"programme" => {
                current = Some(XmlProgram {
                    channel_id: attribute_from(&event, b"channel").unwrap_or_default(),
                    start_at: attribute_from(&event, b"start").unwrap_or_default(),
                    end_at: attribute_from(&event, b"stop").unwrap_or_default(),
                    title: String::new(),
                    description: String::new(),
                });
            }
            Ok(Event::Start(event)) if event.name().as_ref() == b"title" => {
                current_field = Some("title");
            }
            Ok(Event::Start(event)) if event.name().as_ref() == b"desc" => {
                current_field = Some("description");
            }
            Ok(Event::Text(text_event)) => {
                if let Some(field) = current_field {
                    let decoded = text_event
                        .decode()
                        .map_err(|error| format!("EPG 文本解码失败：{error}"))?;
                    let text_value = quick_xml::escape::unescape(decoded.as_ref())
                        .map_err(|error| format!("EPG 文本实体解析失败：{error}"))?
                        .into_owned();
                    if let Some(program) = current.as_mut() {
                        if field == "title" {
                            program.title.push_str(&text_value);
                        } else {
                            program.description.push_str(&text_value);
                        }
                    }
                }
            }
            Ok(Event::End(event))
                if event.name().as_ref() == b"title" || event.name().as_ref() == b"desc" =>
            {
                current_field = None;
            }
            Ok(Event::End(event)) if event.name().as_ref() == b"programme" => {
                if let Some(program) = current.take() {
                    programs.push(program.into_epg());
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("XMLTV 解析失败：{error}")),
            _ => {}
        }
        buffer.clear();
    }
    Ok(programs)
}

fn parse_epg_json(text: &str) -> Result<Vec<EpgProgram>, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("EPG JSON 解析失败：{error}"))?;
    // Providers that serve one channel per request describe the channel once at the top
    // level (`channel_name`) and then list only start/end/title per programme. 112114 — the
    // provider the TVBox `epg` templates point at — is exactly this shape, so the channel
    // identity has to be read from the envelope; without it every item was discarded for
    // having no `channel_id` and the guide always came back empty.
    let envelope_channel = value_text(&value, &["channel_name"]);
    let items = value
        .as_array()
        .cloned()
        // `epg_data` is 112114's key; the others cover the remaining public shapes.
        .or_else(|| value.get("epg_data").and_then(Value::as_array).cloned())
        .or_else(|| value.get("epg").and_then(Value::as_array).cloned())
        .or_else(|| value.get("programs").and_then(Value::as_array).cloned())
        .or_else(|| value.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    Ok(items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let own_channel = value_text(item, &["channel_id", "channel", "tvg_id"]);
            let channel_id = if own_channel.is_empty() {
                envelope_channel.clone()
            } else {
                own_channel
            };
            let title = value_text(item, &["title", "name", "program"]);
            if channel_id.is_empty() || title.is_empty() {
                return None;
            }
            Some(EpgProgram {
                id: format!("{channel_id}-{index}"),
                channel_id,
                title,
                description: value_text(item, &["description", "desc", "content"]),
                start_at: normalize_time(&value_text(item, &["start", "start_at", "startAt"])),
                end_at: normalize_time(&value_text(item, &["end", "end_at", "endAt"])),
            })
        })
        .collect())
}

struct XmlProgram {
    channel_id: String,
    start_at: String,
    end_at: String,
    title: String,
    description: String,
}

impl XmlProgram {
    fn into_epg(self) -> EpgProgram {
        EpgProgram {
            id: format!("{}-{}", self.channel_id, self.start_at),
            channel_id: self.channel_id,
            title: self.title,
            description: self.description,
            start_at: normalize_time(&self.start_at),
            end_at: normalize_time(&self.end_at),
        }
    }
}

fn attribute_from(event: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    event
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.as_ref() == key)
        .and_then(|attribute| String::from_utf8(attribute.value.into_owned()).ok())
}

fn parse_m3u(text: &str, source_key: &str) -> Vec<LiveChannel> {
    let mut channels = Vec::new();
    let mut metadata: Option<(String, String, String, Option<String>)> = None;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with("#EXTINF") {
            let name = line
                .split_once(',')
                .map(|(_, value)| value.trim().to_string())
                .unwrap_or_else(|| "未命名频道".to_string());
            let group = attribute(line, "group-title").unwrap_or_else(|| "未分组".to_string());
            let logo = attribute(line, "tvg-logo").unwrap_or_default();
            let epg_id = attribute(line, "tvg-id");
            metadata = Some((name, group, logo, epg_id));
        } else if !line.starts_with('#') && is_stream_url(line) {
            let (name, group, logo, epg_id) = metadata
                .take()
                .unwrap_or_else(|| (line.to_string(), "未分组".to_string(), String::new(), None));
            if let Some(channel) =
                make_channel(source_key, name, group, logo, epg_id, line.to_string())
            {
                channels.push(channel);
            }
        }
    }
    channels
}

fn parse_txt(text: &str, source_key: &str) -> Vec<LiveChannel> {
    let mut channels = Vec::new();
    let mut group_name = "未分组".to_string();
    let mut pending_name: Option<String> = None;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some((name, marker)) = line.split_once(',') {
            if marker.trim().eq_ignore_ascii_case("#genre#") {
                group_name = name.trim().to_string();
                pending_name = None;
                continue;
            }
        }
        if line.starts_with('#') {
            continue;
        }

        let split = line.split_once(',').or_else(|| line.split_once('$'));
        if let Some((left, right)) = split {
            if is_stream_url(right.trim()) {
                let name = pending_name
                    .take()
                    .unwrap_or_else(|| left.trim().to_string());
                if let Some(channel) = make_channel(
                    source_key,
                    name,
                    group_name.clone(),
                    String::new(),
                    None,
                    right.trim().to_string(),
                ) {
                    channels.push(channel);
                }
                continue;
            }
        }

        if is_stream_url(line) {
            let name = pending_name
                .take()
                .unwrap_or_else(|| "未命名频道".to_string());
            if let Some(channel) = make_channel(
                source_key,
                name,
                group_name.clone(),
                String::new(),
                None,
                line.to_string(),
            ) {
                channels.push(channel);
            }
        } else {
            pending_name = Some(line.to_string());
        }
    }
    channels
}

fn is_stream_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .map(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn parse_json(text: &str, source_key: &str) -> Result<Vec<LiveChannel>, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("直播 JSON 解析失败：{error}"))?;
    let items = value
        .as_array()
        .cloned()
        .or_else(|| value.get("lives").and_then(Value::as_array).cloned())
        .or_else(|| value.get("channels").and_then(Value::as_array).cloned())
        .or_else(|| value.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    Ok(items
        .iter()
        .filter_map(|item| {
            let name = value_text(item, &["name", "channel_name", "title"]);
            let url = value_text(item, &["url", "stream_url", "play_url"]);
            if name.is_empty() || url.is_empty() {
                return None;
            }
            make_channel(
                source_key,
                name,
                value_text(item, &["group", "group_name", "category"]),
                value_text(item, &["logo", "logo_url", "tvg_logo"]),
                optional_value_text(item, &["epg_id", "tvg_id", "channel_id"]),
                url,
            )
        })
        .collect())
}

fn make_channel(
    source_key: &str,
    name: String,
    group_name: String,
    logo_url: String,
    epg_id: Option<String>,
    stream_url: String,
) -> Option<LiveChannel> {
    let parsed_url = reqwest::Url::parse(&stream_url).ok()?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return None;
    }
    if validate_remote_url(&parsed_url).is_err() {
        return None;
    }
    let group_name = if group_name.trim().is_empty() {
        "未分组".to_string()
    } else {
        group_name.trim().to_string()
    };
    let id = format!("{}:{}:{}", source_key, group_name, name);
    Some(LiveChannel {
        id: id.clone(),
        name,
        group_id: slug(&group_name),
        group_name,
        logo_url,
        stream_url: stream_url.clone(),
        stream_urls: vec![stream_url.clone()],
        media_kind: if stream_url.to_ascii_lowercase().contains(".m3u8") {
            "hls".to_string()
        } else if stream_url.to_ascii_lowercase().contains(".mp4") {
            "mp4".to_string()
        } else {
            "unknown".to_string()
        },
        source_key: source_key.to_string(),
        epg_id,
    })
}

fn deduplicate_channels(channels: Vec<LiveChannel>) -> Vec<LiveChannel> {
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut deduplicated: Vec<LiveChannel> = Vec::with_capacity(channels.len());

    for mut channel in channels {
        let identity = channel_identity(&channel);
        if let Some(index) = positions.get(&identity).copied() {
            let existing = &mut deduplicated[index];
            let stream_urls = if channel.stream_urls.is_empty() {
                vec![channel.stream_url.clone()]
            } else {
                channel.stream_urls
            };
            for stream_url in stream_urls {
                if !existing.stream_urls.contains(&stream_url) {
                    existing.stream_urls.push(stream_url);
                }
            }
            if existing.logo_url.is_empty() && !channel.logo_url.is_empty() {
                existing.logo_url = channel.logo_url;
            }
            if existing.epg_id.is_none() {
                existing.epg_id = channel.epg_id;
            }
            continue;
        }

        if channel.stream_urls.is_empty() {
            channel.stream_urls.push(channel.stream_url.clone());
        }
        positions.insert(identity, deduplicated.len());
        deduplicated.push(channel);
    }

    deduplicated
}

fn channel_identity(channel: &LiveChannel) -> String {
    let stable_name = channel
        .epg_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&channel.name);
    format!(
        "{}:{}",
        normalize_identity_part(&channel.group_name),
        normalize_channel_identity(stable_name)
    )
}

fn normalize_channel_identity(value: &str) -> String {
    let without_variant = value.split('@').next().unwrap_or(value);
    let without_quality = without_variant.split('(').next().unwrap_or(without_variant);
    normalize_identity_part(without_quality)
}

fn normalize_identity_part(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect()
}

fn collect_groups(channels: &[LiveChannel]) -> Vec<LiveGroup> {
    let mut groups = Vec::new();
    for channel in channels {
        if !groups
            .iter()
            .any(|group: &LiveGroup| group.id == channel.group_id)
        {
            groups.push(LiveGroup {
                id: channel.group_id.clone(),
                name: channel.group_name.clone(),
            });
        }
    }
    groups
}

fn attribute(line: &str, key: &str) -> Option<String> {
    let marker = format!("{key}=\"");
    let start = line.find(&marker)? + marker.len();
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_string())
}

fn value_text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(|value| value.as_str().map(str::trim).map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn optional_value_text(value: &Value, keys: &[&str]) -> Option<String> {
    let text = value_text(value, keys);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn normalize_time(value: &str) -> String {
    let compact = value.trim();
    if compact.len() >= 12
        && compact.as_bytes()[0..12]
            .iter()
            .all(|character| character.is_ascii_digit())
    {
        return format!("{}:{}", &compact[8..10], &compact[10..12]);
    }
    compact.to_string()
}

fn slug(value: &str) -> String {
    let trimmed = value.trim();
    let ascii = trimmed
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if trimmed.is_ascii() {
        return ascii;
    }
    // Non-ASCII group names (CJK channel groups, for example) lose every character
    // above, which used to collapse unrelated groups into one empty id. Keep the
    // readable ASCII prefix and append a stable hash so distinct groups stay distinct.
    if ascii.is_empty() {
        format!("g{:016x}", fnv1a(trimmed))
    } else {
        format!("{ascii}-{:016x}", fnv1a(trimmed))
    }
}

fn fnv1a(value: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::{
        collect_groups, deduplicate_channels, is_hls_manifest, make_channel, parse_epg_json,
        parse_m3u, parse_txt, parse_xmltv,
    };

    #[test]
    fn only_accepts_hls_manifests_for_the_channel_probe() {
        assert!(is_hls_manifest("#EXTM3U\n#EXT-X-TARGETDURATION:6\n"));
        assert!(is_hls_manifest("\u{feff}\n  #EXTM3U\n"));
        assert!(!is_hls_manifest("<html><body>403 Forbidden</body></html>"));
        assert!(!is_hls_manifest("{\"error\":\"expired\"}"));
        assert!(!is_hls_manifest(""));
    }

    #[test]
    fn parses_m3u_groups_logos_and_epg_ids() {
        let catalog = parse_m3u(
            "#EXTM3U\n#EXTINF:-1 tvg-id=\"news.one\" tvg-logo=\"https://img.example/logo.png\" group-title=\"News\",City News\nhttps://stream.example/news.m3u8\n",
            "live-main",
        );

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].group_name, "News");
        assert_eq!(catalog[0].epg_id.as_deref(), Some("news.one"));
        assert_eq!(catalog[0].media_kind, "hls");
    }

    #[test]
    fn parses_txt_and_json_channels() {
        let txt = parse_txt("Channel A,https://stream.example/a.mp4\n", "live-main");
        let json = super::parse_json(
            r#"[{"name":"Channel B","url":"https://stream.example/b.m3u8","group":"Sports"}]"#,
            "live-main",
        )
        .expect("json channel should parse");

        assert_eq!(txt[0].media_kind, "mp4");
        assert_eq!(json[0].group_name, "Sports");
    }

    #[test]
    fn parses_grouped_two_line_ipv6_txt_sources() {
        let catalog = parse_txt(
            "央视高清,#genre#\nCCTV1\n4M1080,http://[2409:8087::2]/live/cctv1.m3u8\n",
            "ipv6",
        );

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "CCTV1");
        assert_eq!(catalog[0].group_name, "央视高清");
        assert_eq!(catalog[0].media_kind, "hls");
    }

    #[test]
    fn groups_duplicate_channel_names_and_preserves_stream_variants() {
        let parsed = parse_txt(
            "央视频道,#genre#\nCCTV1,https://stream.example/cctv1-main.m3u8\nCCTV-1,https://stream.example/cctv1-backup.m3u8\n",
            "live-main",
        );
        let catalog = deduplicate_channels(parsed);

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "CCTV1");
        assert_eq!(catalog[0].stream_urls.len(), 2);
        assert_eq!(catalog[0].stream_url, catalog[0].stream_urls[0]);
    }

    #[test]
    fn groups_m3u_quality_variants_by_tvg_id_base() {
        let parsed = parse_m3u(
            "#EXTM3U\n#EXTINF:-1 tvg-id=\"CCTV1.cn@HD\" group-title=\"General\",CCTV-1 (1080p)\nhttps://stream.example/cctv1-hd.m3u8\n#EXTINF:-1 tvg-id=\"CCTV1.cn@SD\" group-title=\"General\",CCTV-1 (720p)\nhttps://stream.example/cctv1-sd.m3u8\n",
            "live-main",
        );
        let catalog = deduplicate_channels(parsed);

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].stream_urls.len(), 2);
    }

    #[test]
    fn preserves_source_channel_metadata_without_guessing_translations() {
        let known = make_channel(
            "live-main",
            "CCTV-1 (1080p)".to_string(),
            "General".to_string(),
            String::new(),
            Some("CCTV1.cn@HD".to_string()),
            "https://stream.example/cctv1.m3u8".to_string(),
        )
        .expect("known channel should parse");
        let unknown = make_channel(
            "live-main",
            "BBC World".to_string(),
            "Custom Group".to_string(),
            String::new(),
            Some("BBCWorld.example@SD".to_string()),
            "https://stream.example/bbc.m3u8".to_string(),
        )
        .expect("unknown channel should parse");

        assert_eq!(known.name, "CCTV-1 (1080p)");
        assert_eq!(known.group_name, "General");
        assert_eq!(unknown.name, "BBC World");
        assert_eq!(unknown.group_name, "Custom Group");
    }

    #[test]
    fn keeps_non_ascii_group_names_in_distinct_groups() {
        let catalog = parse_m3u(
            "#EXTM3U\n#EXTINF:-1 group-title=\"央视高清\",CCTV1\nhttp://[2409:8087::2]/live/cctv1.m3u8\n#EXTINF:-1 group-title=\"卫视高清\",CCTV2\nhttp://[2409:8087::2]/live/cctv2.m3u8\n",
            "ipv6",
        );

        assert_eq!(catalog.len(), 2);
        assert!(catalog.iter().all(|channel| !channel.group_id.is_empty()));
        assert_ne!(catalog[0].group_id, catalog[1].group_id);

        let groups = collect_groups(&catalog);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].name, "央视高清");
        assert_eq!(groups[1].name, "卫视高清");
    }

    #[test]
    fn skips_multiline_m3u_metadata_until_the_stream_url() {
        let catalog = parse_m3u(
            "#EXTM3U\n#EXTINF:-1 tvg-id=\"CCTV1\",CCTV-1\ntvg-name=\"CCTV1\"\n综合\nhttp://[2409:8087::2]/live/cctv1.m3u8\n",
            "ipv6",
        );

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "CCTV-1");
        assert_eq!(
            catalog[0].stream_url,
            "http://[2409:8087::2]/live/cctv1.m3u8"
        );
    }

    #[test]
    fn parses_xmltv_and_json_epg() {
        let xml = r#"<?xml version="1.0"?><tv><programme channel="news.one" start="20260914073000 +0800" stop="20260914090000 +0800"><title>Morning News</title><desc>City updates.</desc></programme></tv>"#;
        let xml_programs = parse_xmltv(xml).expect("xmltv should parse");
        let json_programs = parse_epg_json(
            r#"[{"channel_id":"news.one","title":"Next","start":"09:00","end":"10:00"}]"#,
        )
        .expect("json epg should parse");

        assert_eq!(xml_programs[0].channel_id, "news.one");
        assert_eq!(xml_programs[0].start_at, "07:30");
        assert_eq!(json_programs[0].title, "Next");
    }

    /// 112114 (the provider TVBox `epg` templates point at) names the channel once in the
    /// envelope and lists bare start/end/title items under `epg_data`. Both of those broke
    /// the parser: the array key was unknown and every item was dropped for having no
    /// `channel_id`, so the guide was always empty even when the fetch succeeded.
    #[test]
    fn parses_per_channel_epg_json_that_names_the_channel_in_the_envelope() {
        let programs = parse_epg_json(
            r#"{"date":"2026-09-16","channel_name":"CCTV1","url":"epg.112114.xyz",
                "epg_data":[{"start":"01:08","end":"01:30","title":"人口-2026-37"},
                            {"start":"01:30","end":"02:02","title":"晚间新闻"}]}"#,
        )
        .expect("112114 shape should parse");

        assert_eq!(programs.len(), 2);
        assert_eq!(programs[0].channel_id, "CCTV1");
        assert_eq!(programs[0].title, "人口-2026-37");
        assert_eq!(programs[0].start_at, "01:08");
        assert_eq!(programs[1].title, "晚间新闻");
    }

    /// A per-item `channel_id` must still win over the envelope name, so the shape that
    /// carries its own identity keeps working.
    #[test]
    fn prefers_the_item_channel_id_over_the_envelope_name() {
        let programs = parse_epg_json(
            r#"{"channel_name":"envelope","epg_data":[{"channel_id":"item-channel","title":"Show","start":"10:00","end":"11:00"}]}"#,
        )
        .expect("json epg should parse");

        assert_eq!(programs[0].channel_id, "item-channel");
    }
}
