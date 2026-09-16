use std::time::Instant;

use quick_xml::{events::Event, Reader};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    adapters::SiteAdapterKind,
    html,
    policy::{fetch_json, fetch_text, validate_remote_url},
    SourceOperationResult, SourceRecord,
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTestResult {
    pub source_key: String,
    pub status: String,
    pub adapter_id: String,
    pub message: String,
    pub item_count: u64,
    pub category_count: u64,
    pub duration_ms: u64,
    pub tested_at: String,
    pub operations: Vec<SourceOperationResult>,
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
    if adapter == SiteAdapterKind::Html {
        return html::browse_source(source, query, category_id, current_page, current_page_size)
            .await;
    }
    // Only plain JSON CMS sources get the detail-shaped listing. XML list responses already
    // carry `<pic>`, and HTTP-extension sources declare their own parameter conventions, so
    // neither is switched over.
    let wants_detail = listing_ac(adapter) == "detail";
    let params = match adapter {
        SiteAdapterKind::HttpExtension => extension_params(
            query.clone(),
            category_id.clone(),
            current_page,
            current_page_size,
            source.ext.clone(),
        ),
        SiteAdapterKind::Html => unreachable!("HTML 适配器已在参数构造前返回"),
        _ => cms_params_with_ac(
            listing_ac(adapter),
            query.clone(),
            category_id.clone(),
            current_page,
            current_page_size,
        ),
    };
    match fetch_catalog(&source, adapter, &params).await {
        Ok(payload) => {
            let page = parse_catalog_page(&payload, &source.key, current_page, current_page_size);
            if !page.items.is_empty() || !wants_detail {
                return Ok(page);
            }
        }
        // A few MacCMS deployments reject `ac=detail` without `ids`. Falling through to the
        // slim `ac=list` keeps browsing working there, losing only the covers — strictly
        // better than an empty library.
        Err(error) if !wants_detail => return Err(error),
        Err(_) => {}
    }
    let slim = cms_params_with_ac("list", query, category_id, current_page, current_page_size);
    let payload = fetch_catalog(&source, adapter, &slim).await?;
    Ok(parse_catalog_page(
        &payload,
        &source.key,
        current_page,
        current_page_size,
    ))
}

/// Issues the catalog request for one parameter set. Kept separate so the browse path can
/// retry with a different `ac` without duplicating the adapter dispatch.
async fn fetch_catalog(
    source: &SourceRecord,
    adapter: SiteAdapterKind,
    params: &[(String, String)],
) -> Result<Value, String> {
    match adapter {
        SiteAdapterKind::XmlHttp => parse_xml_payload(&request_text(&source.api, params).await?),
        SiteAdapterKind::JsonHttp | SiteAdapterKind::HttpExtension => {
            request_json(&source.api, params).await
        }
        SiteAdapterKind::Html => unreachable!("HTML 适配器已在载荷请求前返回"),
        SiteAdapterKind::Spider | SiteAdapterKind::Unsupported => {
            Err("该源没有可执行的安全站点适配器。".to_string())
        }
    }
}

#[tauri::command]
pub async fn test_source(source: SourceRecord) -> Result<SourceTestResult, String> {
    let adapter = SiteAdapterKind::from_source(&source);
    let adapter_id = adapter.id().to_string();
    let source_key = source.key.clone();
    let tested_at = "刚刚".to_string();
    let started = Instant::now();
    if let Err(error) = adapter.ensure_executable(&source) {
        return Ok(SourceTestResult {
            source_key,
            status: "blocked".to_string(),
            adapter_id,
            message: error,
            item_count: 0,
            category_count: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            tested_at,
            operations: Vec::new(),
        });
    }

    match browse_source(source.clone(), String::new(), None, 1, 8).await {
        Ok(catalog) => {
            let item_count = catalog
                .items
                .iter()
                .filter(|item| !item.name.trim().is_empty())
                .count() as u64;
            let category_count = catalog.categories.len() as u64;
            let (status, message) = if item_count > 0 {
                (
                    "passed",
                    format!("请求成功，识别到 {item_count} 条影视内容和 {category_count} 个分类。"),
                )
            } else {
                (
                    "empty",
                    "请求成功，但响应中没有可识别的影视内容。".to_string(),
                )
            };
            let mut operations = vec![SourceOperationResult {
                operation: "catalog".to_string(),
                status: status.to_string(),
                message: message.clone(),
                duration_ms: started.elapsed().as_millis() as u64,
            }];
            operations.push(SourceOperationResult {
                operation: "category".to_string(),
                status: if category_count > 0 {
                    "passed"
                } else {
                    "empty"
                }
                .to_string(),
                message: if category_count > 0 {
                    format!("识别到 {category_count} 个分类。")
                } else {
                    "响应中没有分类数据。".to_string()
                },
                duration_ms: 0,
            });

            let detail_operation = if let Some(item) = catalog.items.first() {
                let detail_started = Instant::now();
                match get_detail(source.clone(), item.id.clone()).await {
                    Ok(Some(_)) => SourceOperationResult {
                        operation: "detail".to_string(),
                        status: "passed".to_string(),
                        message: "首条影视内容详情可读取。".to_string(),
                        duration_ms: detail_started.elapsed().as_millis() as u64,
                    },
                    Ok(None) => SourceOperationResult {
                        operation: "detail".to_string(),
                        status: "empty".to_string(),
                        message: "详情请求成功，但没有返回可识别详情。".to_string(),
                        duration_ms: detail_started.elapsed().as_millis() as u64,
                    },
                    Err(error) => SourceOperationResult {
                        operation: "detail".to_string(),
                        status: "failed".to_string(),
                        message: error,
                        duration_ms: detail_started.elapsed().as_millis() as u64,
                    },
                }
            } else {
                SourceOperationResult {
                    operation: "detail".to_string(),
                    status: "skipped".to_string(),
                    message: "没有可用于详情探测的影视条目。".to_string(),
                    duration_ms: 0,
                }
            };
            operations.push(detail_operation);

            let playback_operation = catalog
                .items
                .iter()
                .flat_map(|item| item.play_lines.iter())
                .flat_map(|line| line.episodes.iter())
                .next()
                .map(|episode| {
                    let status = reqwest::Url::parse(&episode.url)
                        .ok()
                        .filter(|url| validate_remote_url(url).is_ok())
                        .map(|_| "passed")
                        .unwrap_or("failed");
                    SourceOperationResult {
                        operation: "playback".to_string(),
                        status: status.to_string(),
                        message: if status == "passed" {
                            "已识别出可通过媒体安全策略的播放地址。".to_string()
                        } else {
                            "播放地址未通过 HTTP/HTTPS 安全策略。".to_string()
                        },
                        duration_ms: 0,
                    }
                })
                .unwrap_or_else(|| SourceOperationResult {
                    operation: "playback".to_string(),
                    status: "empty".to_string(),
                    message: "首批影视内容没有可识别的播放地址。".to_string(),
                    duration_ms: 0,
                });
            operations.push(playback_operation);
            operations.push(SourceOperationResult {
                operation: "search".to_string(),
                status: if source.searchable {
                    "skipped"
                } else {
                    "blocked"
                }
                .to_string(),
                message: if source.searchable {
                    "未提供稳定探测关键词，未发起搜索请求。".to_string()
                } else {
                    "源配置将搜索标记为不可用。".to_string()
                },
                duration_ms: 0,
            });
            Ok(SourceTestResult {
                source_key,
                status: status.to_string(),
                adapter_id,
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
                adapter_id,
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
pub async fn get_detail(source: SourceRecord, vod_id: String) -> Result<Option<VodItem>, String> {
    let adapter = SiteAdapterKind::from_source(&source).ensure_executable(&source)?;
    if adapter == SiteAdapterKind::Html {
        return html::get_detail(source, vod_id).await;
    }
    let params = vec![
        ("ac".to_string(), "detail".to_string()),
        ("ids".to_string(), vod_id.clone()),
    ];
    let payload = match adapter {
        SiteAdapterKind::Html => unreachable!("HTML 适配器已在详情请求前返回"),
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
        .and_then(|items| {
            items
                .iter()
                .find(|value| is_supported_item(&payload, value))
        })
        .or_else(|| {
            payload
                .get("data")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|value| is_supported_item(&payload, value))
                })
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

/// Which `ac` a catalog listing should use for a given adapter. Only plain JSON CMS sources
/// need the detail-shaped listing, because only MacCMS hides `vod_pic` behind `ac=detail`;
/// XML list responses already carry `<pic>`, and extension sources declare their own
/// parameters through `ext`, so neither is switched over.
fn listing_ac(adapter: SiteAdapterKind) -> &'static str {
    match adapter {
        SiteAdapterKind::JsonHttp => "detail",
        _ => "list",
    }
}

/// MacCMS distinguishes `ac=list` (slim rows: id, name, type, play_from) from `ac=detail`
/// (full records including `vod_pic`). Browsing used `ac=list`, so every item arrived without
/// a poster — measured against real sources, `ac=list` returned 0 covers out of 20 while
/// `ac=detail` returned 20 out of 20, and `vod_area` was missing for the same reason. Asking
/// for detail records costs one larger response (~40-180 KiB against a 15 MiB budget) and
/// still honours `pg`, `wd` and `t`, so no extra request is needed.
///
/// `list` is kept for the fallback path: a deployment that rejects `ac=detail` for listings
/// still browses, just without covers.
fn cms_params_with_ac(
    ac: &str,
    query: String,
    category_id: Option<String>,
    page: u32,
    page_size: u32,
) -> Vec<(String, String)> {
    let mut params = vec![
        ("ac".to_string(), ac.to_string()),
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
    // Extension sources declare their own `ac` via `ext`, so this stays on the historical
    // `list` default rather than inheriting the JSON CMS switch to `ac=detail`.
    let mut params = cms_params_with_ac("list", query, category_id, page, page_size);
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
                let decoded = event
                    .decode()
                    .map_err(|error| format!("CMS XML 文本解码失败：{error}"))?;
                let value = quick_xml::escape::unescape(decoded.as_ref())
                    .map_err(|error| format!("CMS XML 文本实体解析失败：{error}"))?
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
    payload.insert("_moseek_xml".to_string(), Value::Bool(true));
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
    let is_xml_payload = payload
        .get("_moseek_xml")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let items = list
        .iter()
        .filter(|value| is_xml_payload || is_cms_item(value))
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

fn is_cms_item(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let primary_field_count = [
        "vod_id",
        "vod_name",
        "vod_pic",
        "vod_play_from",
        "vod_play_url",
        "vod_year",
        "vod_content",
        "vod_actor",
        "vod_director",
        "vod_area",
        "vod_class",
    ]
    .iter()
    .filter(|field| object.get(**field).is_some())
    .count();
    let cms_field_count = primary_field_count
        + ["type_id", "type_name"]
            .iter()
            .filter(|field| object.get(**field).is_some())
            .count();
    primary_field_count > 0 && cms_field_count >= 2
}

fn is_supported_item(payload: &Value, value: &Value) -> bool {
    payload
        .get("_moseek_xml")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || is_cms_item(value)
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
        description: plain_text(&value_text(
            value,
            &["vod_content", "vod_blurb", "content", "description"],
        )),
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
        .split(['/', ',', '、', '|'])
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
        .split(['/', ',', '、', '|'])
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

/// `vod_content` is a rich-text field and some sources fill it with markup (measured: one
/// source returned `<p><span style=...>` in 9 of 20 items). The UI renders descriptions as
/// escaped text, so the tags would show up literally. Tags are dropped, each tag boundary
/// becomes a space, and the common entities are decoded.
fn plain_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '<' => {
                // Consume the tag; the boundary becomes a space so words do not run together.
                for inner in chars.by_ref() {
                    if inner == '>' {
                        break;
                    }
                }
                if !out.is_empty() && !out.ends_with(' ') {
                    out.push(' ');
                }
            }
            '&' => {
                let mut entity = String::new();
                let mut terminated = false;
                while let Some(&next) = chars.peek() {
                    if next == ';' {
                        chars.next();
                        terminated = true;
                        break;
                    }
                    if entity.len() > 8 || next.is_whitespace() || next == '&' || next == '<' {
                        break;
                    }
                    entity.push(next);
                    chars.next();
                }
                if terminated {
                    match entity.as_str() {
                        "amp" => out.push('&'),
                        "lt" => out.push('<'),
                        "gt" => out.push('>'),
                        "quot" => out.push('"'),
                        "apos" | "#39" => out.push('\''),
                        "nbsp" | "#160" => out.push(' '),
                        _ => {
                            out.push('&');
                            out.push_str(&entity);
                            out.push(';');
                        }
                    }
                } else {
                    out.push('&');
                    out.push_str(&entity);
                }
            }
            _ => out.push(ch),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
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
    use serde_json::json;

    use super::{
        cms_params_with_ac, extension_params, listing_ac, parse_catalog_page, parse_xml_payload,
    };
    use crate::adapters::SiteAdapterKind;

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

    #[test]
    fn ignores_generic_data_arrays_without_cms_fields() {
        let page = parse_catalog_page(
            &json!({
                "data": [{
                    "id": "file-1",
                    "name": "网盘文件",
                    "downloadUrl": "https://example.com/file"
                }]
            }),
            "generic-api",
            1,
            20,
        );

        assert!(page.items.is_empty());
    }

    #[test]
    fn accepts_canonical_cms_vod_fields() {
        let page = parse_catalog_page(
            &json!({
                "data": [{
                    "vod_id": "movie-1",
                    "vod_name": "测试影片",
                    "vod_pic": "https://example.com/poster.jpg",
                    "vod_play_from": "线路一",
                    "vod_play_url": "正片$https://example.com/movie.m3u8"
                }]
            }),
            "cms-api",
            1,
            20,
        );

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].name, "测试影片");
    }

    /// Browsing used `ac=list`, whose rows carry no `vod_pic`, so every card rendered without
    /// a cover. JSON CMS listings now ask for `ac=detail`, which returns full records.
    #[test]
    fn json_cms_listings_request_detail_records_so_posters_arrive() {
        assert_eq!(listing_ac(SiteAdapterKind::JsonHttp), "detail");

        let params = cms_params_with_ac(
            listing_ac(SiteAdapterKind::JsonHttp),
            String::new(),
            None,
            1,
            12,
        );

        assert!(params.contains(&("ac".to_string(), "detail".to_string())));
        assert!(params.contains(&("pg".to_string(), "1".to_string())));
        assert!(params.contains(&("limit".to_string(), "12".to_string())));
    }

    /// XML and extension sources are deliberately left on `ac=list`: XML already returns
    /// `<pic>`, and extension sources declare their own parameters.
    #[test]
    fn xml_and_extension_sources_keep_the_slim_listing() {
        assert_eq!(listing_ac(SiteAdapterKind::XmlHttp), "list");
        assert_eq!(listing_ac(SiteAdapterKind::HttpExtension), "list");
        assert_eq!(listing_ac(SiteAdapterKind::Html), "list");
        assert_eq!(listing_ac(SiteAdapterKind::Unsupported), "list");
    }

    /// The fallback path must still be able to ask for the slim listing.
    #[test]
    fn slim_listing_variant_still_uses_ac_list() {
        let params = cms_params_with_ac("list", "关键词".to_string(), Some("电影".to_string()), 3, 20);

        assert!(params.contains(&("ac".to_string(), "list".to_string())));
        assert!(params.contains(&("pg".to_string(), "3".to_string())));
        assert!(params.contains(&("wd".to_string(), "关键词".to_string())));
        assert!(params.contains(&("t".to_string(), "电影".to_string())));
    }

    /// Extension sources declare their own `ac` through `ext`, so they must keep the `list`
    /// default rather than silently inheriting the JSON CMS switch.
    #[test]
    fn extension_params_keep_the_list_default() {
        let params = extension_params(String::new(), None, 1, 20, None);

        assert!(params.contains(&("ac".to_string(), "list".to_string())));
    }

    /// `vod_content` is rich text; some sources return markup and the UI renders descriptions
    /// as escaped text, so tags would appear literally.
    #[test]
    fn strips_markup_from_item_descriptions() {
        let page = parse_catalog_page(
            &json!({
                "list": [{
                    "vod_id": "movie-2",
                    "vod_name": "测试影片",
                    "vod_content": "<p><span style=\"color: rgb(17, 17, 17);\">第一段 &amp; 第二段</span></p><br/>第三段"
                }]
            }),
            "cms-api",
            1,
            20,
        );

        assert_eq!(page.items[0].description, "第一段 & 第二段 第三段");
    }

    #[test]
    fn keeps_plain_descriptions_intact() {
        let page = parse_catalog_page(
            &json!({
                "list": [{
                    "vod_id": "movie-3",
                    "vod_name": "测试影片",
                    "vod_content": "改编自同名小说。\n顾长歌穿越到玄幻世界。"
                }]
            }),
            "cms-api",
            1,
            20,
        );

        assert_eq!(page.items[0].description, "改编自同名小说。 顾长歌穿越到玄幻世界。");
    }

    /// `vod_area` is frequently absent, which is why the card showed "未知地区". The parser
    /// must pass the empty string through so the UI can omit the field rather than invent one.
    #[test]
    fn missing_area_stays_empty_rather_than_becoming_a_placeholder() {
        let page = parse_catalog_page(
            &json!({
                "list": [{ "vod_id": "movie-4", "vod_name": "测试影片" }]
            }),
            "cms-api",
            1,
            20,
        );

        assert_eq!(page.items[0].area, "");
    }

    #[test]
    fn plain_text_handles_entities_and_stray_markup() {
        assert_eq!(super::plain_text("a &lt; b &gt; c"), "a < b > c");
        assert_eq!(super::plain_text("x&nbsp;y"), "x y");
        assert_eq!(super::plain_text("未知实体 &foo; 保留"), "未知实体 &foo; 保留");
        assert_eq!(super::plain_text("<b>粗体</b>普通"), "粗体 普通");
        assert_eq!(super::plain_text("  多   空格  "), "多 空格");
        assert_eq!(super::plain_text(""), "");
    }
}
