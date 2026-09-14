use quick_xml::{events::Event, Reader};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::{
    adapters::SiteAdapterKind,
    policy::{fetch_json, fetch_text, validate_remote_url},
    SourceRecord,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VodCategory {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VodEpisode {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VodPlayLine {
    pub id: String,
    pub name: String,
    pub episodes: Vec<VodEpisode>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VodItem {
    pub id: String,
    pub source_key: String,
    pub source_name: String,
    pub name: String,
    pub poster: String,
    pub description: String,
    pub year: String,
    pub area: String,
    pub categories: Vec<VodCategory>,
    pub actors: Vec<String>,
    pub directors: Vec<String>,
    pub play_lines: Vec<VodPlayLine>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub source_key: String,
    pub items: Vec<VodItem>,
    pub categories: Vec<VodCategory>,
    pub page: u32,
    pub page_count: u32,
    pub page_size: u32,
    pub total: u64,
}

#[tauri::command]
pub async fn browse_source(
    source: SourceRecord,
    query: String,
    category_id: Option<String>,
    page: u32,
    page_size: u32,
) -> Result<CatalogPage, String> {
    let adapter = SiteAdapterKind::from_source(&source).ensure_executable(&source)?;
    let current_page = page.max(1);
    let current_page_size = page_size.clamp(1, 100);
    let params = match adapter {
        SiteAdapterKind::HttpExtension => extension_params(
            query,
            category_id,
            current_page,
            current_page_size,
            source.ext.clone(),
        ),
        _ => cms_params(query, category_id, current_page, current_page_size),
    };
    let payload = match adapter {
        SiteAdapterKind::XmlHttp => parse_xml_payload(&request_text(&source.api, &params).await?)?,
        SiteAdapterKind::JsonHttp | SiteAdapterKind::HttpExtension => {
            request_json(&source.api, &params).await?
        }
        SiteAdapterKind::Spider | SiteAdapterKind::Unsupported => {
            return Err("该源没有可执行的安全站点适配器。".to_string());
        }
    };
    Ok(parse_catalog_page(
        &payload,
        &source.key,
        current_page,
        current_page_size,
    ))
}

#[tauri::command]
pub async fn get_detail(source: SourceRecord, vod_id: String) -> Result<Option<VodItem>, String> {
    let adapter = SiteAdapterKind::from_source(&source).ensure_executable(&source)?;
    let params = vec![
        ("ac".to_string(), "detail".to_string()),
        ("ids".to_string(), vod_id),
    ];
    let payload = match adapter {
        SiteAdapterKind::XmlHttp => parse_xml_payload(&request_text(&source.api, &params).await?)?,
        SiteAdapterKind::JsonHttp | SiteAdapterKind::HttpExtension => {
            request_json(&source.api, &params).await?
        }
        SiteAdapterKind::Spider | SiteAdapterKind::Unsupported => {
            return Err("该源没有可执行的安全站点适配器。".to_string());
        }
    };
    let item = payload
        .get("list")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .or_else(|| {
            payload
                .get("data")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
        })
        .map(|value| parse_item(value, &source.key));
    Ok(item)
}

async fn request_json(api: &str, params: &[(String, String)]) -> Result<Value, String> {
    let mut url = reqwest::Url::parse(api).map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in params {
            query.append_pair(key, value);
        }
    }
    fetch_json(url, 15 * 1024 * 1024, "CMS 响应").await
}

async fn request_text(api: &str, params: &[(String, String)]) -> Result<String, String> {
    let mut url = reqwest::Url::parse(api).map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in params {
            query.append_pair(key, value);
        }
    }
    fetch_text(url, 15 * 1024 * 1024, "CMS 响应").await
}

fn cms_params(
    query: String,
    category_id: Option<String>,
    page: u32,
    page_size: u32,
) -> Vec<(String, String)> {
    let mut params = vec![
        ("ac".to_string(), "list".to_string()),
        ("pg".to_string(), page.to_string()),
        ("limit".to_string(), page_size.to_string()),
    ];
    if !query.trim().is_empty() {
        params.push(("wd".to_string(), query.trim().to_string()));
    }
    if let Some(category) = category_id.filter(|value| value != "all" && !value.is_empty()) {
        params.push(("t".to_string(), category));
    }
    params
}

fn extension_params(
    query: String,
    category_id: Option<String>,
    page: u32,
    page_size: u32,
    ext: Option<String>,
) -> Vec<(String, String)> {
    let mut params = cms_params(query, category_id, page, page_size);
    if let Some(ext) = ext.filter(|value| !value.trim().is_empty()) {
        if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&ext) {
            for field in ["params", "query", "httpParams"] {
                if let Some(Value::Object(values)) = object.get(field) {
                    append_scalar_params(&mut params, values);
                }
            }
        }
    }
    params
}

fn append_scalar_params(params: &mut Vec<(String, String)>, values: &Map<String, Value>) {
    for (key, value) in values {
        let scalar = match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            Value::Bool(value) => Some(value.to_string()),
            _ => None,
        };
        if let Some(value) = scalar {
            params.push((key.clone(), value));
        }
    }
}

fn parse_xml_payload(text: &str) -> Result<Value, String> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut items = Vec::new();
    let mut categories = Vec::new();
    let mut current_item: Option<Map<String, Value>> = None;
    let mut current_category: Option<Map<String, Value>> = None;
    let mut current_field: Option<String> = None;
    let mut record_count: Option<String> = None;
    let mut page_count: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let tag = String::from_utf8_lossy(event.name().as_ref()).to_ascii_lowercase();
                if tag == "list" {
                    record_count = xml_attribute(&event, b"recordcount");
                    page_count = xml_attribute(&event, b"pagecount");
                } else if tag == "video" || tag == "vod" {
                    current_item = Some(Map::new());
                    current_field = None;
                } else if current_item.is_none() && (tag == "ty" || tag == "type") {
                    let mut category = Map::new();
                    if let Some(id) = xml_attribute(&event, b"id") {
                        category.insert("id".to_string(), Value::String(id));
                    }
                    current_category = Some(category);
                    current_field = Some("name".to_string());
                } else if current_item.is_some() || current_category.is_some() {
                    current_field = Some(tag);
                }
            }
            Ok(Event::Text(event)) => {
                let value = event
                    .unescape()
                    .map_err(|error| format!("CMS XML 文本解析失败：{error}"))?
                    .into_owned();
                store_xml_value(
                    &mut current_item,
                    &mut current_category,
                    current_field.as_deref(),
                    value,
                );
            }
            Ok(Event::CData(event)) => {
                let value = String::from_utf8_lossy(event.as_ref()).into_owned();
                store_xml_value(
                    &mut current_item,
                    &mut current_category,
                    current_field.as_deref(),
                    value,
                );
            }
            Ok(Event::End(event)) => {
                let tag = String::from_utf8_lossy(event.name().as_ref()).to_ascii_lowercase();
                if tag == "video" || tag == "vod" {
                    if let Some(item) = current_item.take() {
                        items.push(Value::Object(item));
                    }
                } else if tag == "ty" || tag == "type" {
                    if let Some(category) = current_category.take() {
                        categories.push(Value::Object(category));
                    }
                }
                current_field = None;
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("CMS XML 解析失败：{error}")),
            _ => {}
        }
        buffer.clear();
    }

    let mut payload = Map::new();
    payload.insert("list".to_string(), Value::Array(items));
    payload.insert("class".to_string(), Value::Array(categories));
    if let Some(record_count) = record_count {
        payload.insert("recordcount".to_string(), Value::String(record_count));
    }
    if let Some(page_count) = page_count {
        payload.insert("pagecount".to_string(), Value::String(page_count));
    }
    Ok(Value::Object(payload))
}

fn store_xml_value(
    current_item: &mut Option<Map<String, Value>>,
    current_category: &mut Option<Map<String, Value>>,
    field: Option<&str>,
    value: String,
) {
    let Some(field) = field else {
        return;
    };
    if let Some(item) = current_item.as_mut() {
        item.insert(field.to_string(), Value::String(value));
    } else if let Some(category) = current_category.as_mut() {
        if field == "name" || field == "type_name" || field == "title" {
            category.insert("name".to_string(), Value::String(value));
        }
    }
}

fn xml_attribute(event: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> Option<String> {
    event
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.as_ref() == key)
        .and_then(|attribute| String::from_utf8(attribute.value.into_owned()).ok())
}

fn parse_catalog_page(payload: &Value, source_key: &str, page: u32, page_size: u32) -> CatalogPage {
    let list = payload
        .get("list")
        .and_then(Value::as_array)
        .or_else(|| payload.get("data").and_then(Value::as_array))
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let items = list
        .iter()
        .map(|value| parse_item(value, source_key))
        .collect::<Vec<_>>();
    let total = value_u64(payload, &["total", "recordcount"]).unwrap_or(items.len() as u64);
    let page_count = value_u64(payload, &["pagecount", "page_count"])
        .map(|value| value.max(1) as u32)
        .unwrap_or_else(|| ((total as f64 / page_size as f64).ceil() as u32).max(1));
    CatalogPage {
        source_key: source_key.to_string(),
        items,
        categories: parse_categories(payload),
        page,
        page_count,
        page_size,
        total,
    }
}

fn parse_item(value: &Value, source_key: &str) -> VodItem {
    let item_id = value_text(value, &["vod_id", "id", "ids"]);
    let item_id = if item_id.is_empty() {
        format!("{source_key}-unknown")
    } else {
        item_id
    };
    VodItem {
        id: item_id.clone(),
        source_key: source_key.to_string(),
        source_name: source_key.to_string(),
        name: value_text(value, &["vod_name", "name", "title"]),
        poster: value_text(
            value,
            &["vod_pic", "vod_pic_thumb", "vod_pic_slide", "pic", "poster"],
        ),
        description: value_text(
            value,
            &["vod_content", "vod_blurb", "content", "description"],
        ),
        year: value_text(value, &["vod_year", "year"]),
        area: value_text(value, &["vod_area", "area"]),
        categories: parse_item_categories(value),
        actors: split_people(&value_text(value, &["vod_actor", "actor", "actors"])),
        directors: split_people(&value_text(
            value,
            &["vod_director", "director", "directors"],
        )),
        play_lines: parse_play_lines(value, &item_id),
    }
}

fn parse_categories(payload: &Value) -> Vec<VodCategory> {
    payload
        .get("class")
        .or_else(|| payload.get("categories"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let id = value_text(value, &["type_id", "id"]);
                    VodCategory {
                        id: if id.is_empty() {
                            (index + 1).to_string()
                        } else {
                            id
                        },
                        name: value_text(value, &["type_name", "name", "title"]),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_item_categories(value: &Value) -> Vec<VodCategory> {
    let class = value_text(value, &["vod_class", "category", "categories"]);
    class
        .split(|character| matches!(character, '/' | ',' | '、' | '|'))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .enumerate()
        .map(|(index, name)| VodCategory {
            id: format!("category-{index}"),
            name: name.to_string(),
        })
        .collect()
}

fn parse_play_lines(value: &Value, item_id: &str) -> Vec<VodPlayLine> {
    let line_names = split_delimited(&value_text(value, &["vod_play_from", "play_from"]), "$$$");
    let line_values = split_delimited(&value_text(value, &["vod_play_url", "play_url"]), "$$$");
    let count = line_names.len().max(line_values.len());
    if count == 0 {
        return Vec::new();
    }
    (0..count)
        .map(|index| {
            let name = line_names
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("线路 {}", index + 1));
            let episodes = line_values
                .get(index)
                .map(|value| parse_episodes(value, item_id, index))
                .unwrap_or_default();
            VodPlayLine {
                id: format!("{item_id}-line-{index}"),
                name,
                episodes,
            }
        })
        .collect()
}

fn parse_episodes(value: &str, item_id: &str, line_index: usize) -> Vec<VodEpisode> {
    let episodes = value
        .split('#')
        .enumerate()
        .filter_map(|(index, entry)| {
            let (name, url) = entry
                .split_once('$')
                .or_else(|| entry.split_once('|'))
                .unwrap_or(("正片", entry));
            let url = url.trim();
            if url.is_empty() {
                return None;
            }
            let parsed_url = reqwest::Url::parse(url).ok()?;
            if validate_remote_url(&parsed_url).is_err() {
                return None;
            }
            Some(VodEpisode {
                id: format!("{item_id}-episode-{line_index}-{index}"),
                name: if name.trim().is_empty() {
                    format!("第 {} 集", index + 1)
                } else {
                    name.trim().to_string()
                },
                url: url.to_string(),
            })
        })
        .collect::<Vec<_>>();
    if episodes.is_empty() && !value.trim().is_empty() {
        let parsed_url = reqwest::Url::parse(value.trim()).ok();
        if parsed_url
            .as_ref()
            .map(|url| validate_remote_url(url).is_ok())
            != Some(true)
        {
            return Vec::new();
        }
        return vec![VodEpisode {
            id: format!("{item_id}-episode-{line_index}-0"),
            name: "正片".to_string(),
            url: value.trim().to_string(),
        }];
    }
    episodes
}

fn split_delimited(value: &str, delimiter: &str) -> Vec<String> {
    value
        .split(delimiter)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn split_people(value: &str) -> Vec<String> {
    value
        .split(|character| matches!(character, '/' | ',' | '、' | '|'))
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn value_text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key))
        .map(|value| match value {
            Value::String(value) => value.trim().to_string(),
            Value::Number(value) => value.to_string(),
            Value::Bool(value) => value.to_string(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

fn value_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
}

#[cfg(test)]
mod tests {
    use super::{extension_params, parse_catalog_page, parse_xml_payload};

    #[test]
    fn parses_tvbox_xml_items_categories_and_cdata() {
        let payload = parse_xml_payload(
            r#"<rss><class><ty id="1"><![CDATA[电影]]></ty></class><list recordcount="1" pagecount="1"><video><id>demo-1</id><name><![CDATA[测试影片]]></name><pic>https://example.com/poster.jpg</pic><play_from>线路一</play_from><play_url><![CDATA[第一集$https://example.com/video.m3u8]]></play_url></video></list></rss>"#,
        )
        .unwrap();
        let page = parse_catalog_page(&payload, "xml-source", 1, 20);

        assert_eq!(page.total, 1);
        assert_eq!(page.categories[0].name, "电影");
        assert_eq!(page.items[0].name, "测试影片");
        assert_eq!(
            page.items[0].play_lines[0].episodes[0].url,
            "https://example.com/video.m3u8"
        );
    }

    #[test]
    fn only_scalar_http_extension_params_are_forwarded() {
        let params = extension_params(
            "关键词".to_string(),
            Some("电影".to_string()),
            2,
            20,
            Some(
                r#"{"params":{"token":"demo","pageSize":20,"nested":{"ignored":true}},"headers":{"Authorization":"secret"}}"#.to_string(),
            ),
        );

        assert!(params.contains(&("token".to_string(), "demo".to_string())));
        assert!(params.contains(&("pageSize".to_string(), "20".to_string())));
        assert!(!params
            .iter()
            .any(|(key, _)| key == "headers" || key == "nested"));
    }
}
