use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;
use serde_json::Value;

use crate::{
    policy::{fetch_text, validate_remote_url},
    SourceRecord,
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
    if source.capability == "blocked" || source.capability == "invalid" {
        return Err(source.capability_note);
    }
    let source_key = source.key;
    let source_url = source.api;
    let format = source.ext.unwrap_or_else(|| "auto".to_string());
    let url = reqwest::Url::parse(&source_url).map_err(|error| error.to_string())?;
    let format = format.to_ascii_lowercase();
    let text = fetch_text(url, 20 * 1024 * 1024, "直播源响应").await?;
    let channels = if format == "json"
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
    let groups = collect_groups(&channels);
    Ok(LiveCatalog { channels, groups })
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
                    let text_value = text_event
                        .unescape()
                        .map_err(|error| format!("EPG 文本解析失败：{error}"))?
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
    let items = value
        .as_array()
        .cloned()
        .or_else(|| value.get("epg").and_then(Value::as_array).cloned())
        .or_else(|| value.get("programs").and_then(Value::as_array).cloned())
        .or_else(|| value.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    Ok(items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let channel_id = value_text(item, &["channel_id", "channel", "tvg_id"]);
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
        } else if !line.starts_with('#') {
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
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let (name, url) = line.split_once(',').or_else(|| line.split_once('$'))?;
            make_channel(
                source_key,
                name.trim().to_string(),
                "未分组".to_string(),
                String::new(),
                None,
                url.trim().to_string(),
            )
        })
        .collect()
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
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{parse_epg_json, parse_m3u, parse_txt, parse_xmltv};

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
}
