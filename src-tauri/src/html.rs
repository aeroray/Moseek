use std::collections::HashMap;

use scraper::{ElementRef, Html, Selector};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::{
    cms::{CatalogPage, VodCategory, VodEpisode, VodItem, VodPlayLine},
    policy::{fetch_text_with_headers, validate_remote_url},
    SourceRecord,
};

#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HtmlAdapterConfig {
    item_selector: String,
    #[serde(default)]
    fields: HashMap<String, HtmlFieldSpec>,
    #[serde(default)]
    request: HtmlRequestConfig,
    #[serde(default)]
    detail: Option<HtmlDetailConfig>,
    #[serde(default)]
    total_selector: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum HtmlFieldSpec {
    Selector(String),
    Detailed(HtmlFieldConfig),
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HtmlFieldConfig {
    selector: String,
    #[serde(default)]
    attr: Option<String>,
    #[serde(default)]
    attribute: Option<String>,
}

#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HtmlRequestConfig {
    #[serde(default)]
    params: Map<String, Value>,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HtmlDetailConfig {
    #[serde(default)]
    item_selector: Option<String>,
    #[serde(default)]
    fields: Option<HashMap<String, HtmlFieldSpec>>,
    #[serde(default)]
    url_template: Option<String>,
}

pub(crate) async fn browse_source(
    source: SourceRecord,
    query: String,
    category_id: Option<String>,
    page: u32,
    page_size: u32,
) -> Result<CatalogPage, String> {
    let config = config_for_source(&source)?;
    let url = build_request_url(
        &source.api,
        &config.request.params,
        &query,
        category_id.as_deref(),
        page,
        page_size,
        None,
    )?;
    let html = fetch_html(&url, &config.request.headers).await?;
    parse_catalog(&html, &url, &source, &config, page, page_size)
}

pub(crate) async fn get_detail(
    source: SourceRecord,
    vod_id: String,
) -> Result<Option<VodItem>, String> {
    let config = config_for_source(&source)?;
    let detail_config = config.detail.clone().unwrap_or_default();
    let detail_url = if let Ok(url) = reqwest::Url::parse(&vod_id) {
        validate_remote_url(&url)?;
        url
    } else if let Some(template) = detail_config.url_template.as_deref() {
        let url = apply_template(
            template,
            &HtmlTemplateValues {
                query: "",
                category_id: "",
                page: 1,
                page_size: 1,
                id: &vod_id,
            },
        );
        let url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
        validate_remote_url(&url)?;
        url
    } else {
        return Err("HTML 源详情缺少可访问的 detailUrl 或 urlTemplate。".to_string());
    };
    let html = fetch_html(&detail_url, &config.request.headers).await?;
    let document = Html::parse_document(&html);
    let root = detail_config
        .item_selector
        .as_deref()
        .map(parse_selector)
        .transpose()?
        .and_then(|selector| document.select(&selector).next())
        .unwrap_or_else(|| document.root_element());
    let fields = detail_config.fields.as_ref().unwrap_or(&config.fields);
    let item = parse_item(
        root,
        detail_url.as_str(),
        &source,
        fields,
        &format!("{}-detail", source.key),
    )?;
    Ok(item.filter(|item| !item.name.is_empty() || !item.play_lines.is_empty()))
}

fn config_for_source(source: &SourceRecord) -> Result<HtmlAdapterConfig, String> {
    for raw in [source.extra.as_ref(), source.ext.as_ref()]
        .into_iter()
        .flatten()
    {
        let value: Value = serde_json::from_str(raw)
            .map_err(|error| format!("HTML 源配置不是有效 JSON：{error}"))?;
        for candidate in config_candidates(&value) {
            let config: HtmlAdapterConfig = serde_json::from_value(candidate)
                .map_err(|error| format!("HTML 源字段映射无效：{error}"))?;
            if !config.item_selector.trim().is_empty() {
                validate_html_config(&config)?;
                return Ok(config);
            }
        }
    }
    Err("HTML 源缺少 itemSelector 配置。".to_string())
}

fn config_candidates(value: &Value) -> Vec<Value> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    if let Some(html) = object.get("html").filter(|value| value.is_object()) {
        candidates.push(html.clone());
    }
    let marker = object
        .get("adapter")
        .or_else(|| object.get("format"))
        .or_else(|| object.get("type"))
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase);
    if marker.as_deref() == Some("html") || object.contains_key("itemSelector") {
        candidates.push(value.clone());
    }
    candidates
}

fn build_request_url(
    api: &str,
    params: &Map<String, Value>,
    query: &str,
    category_id: Option<&str>,
    page: u32,
    page_size: u32,
    id: Option<&str>,
) -> Result<reqwest::Url, String> {
    let values = HtmlTemplateValues {
        query,
        category_id: category_id.unwrap_or_default(),
        page,
        page_size,
        id: id.unwrap_or_default(),
    };
    let mut url = reqwest::Url::parse(&apply_template(api, &values))
        .map_err(|error| format!("HTML 源地址无效：{error}"))?;
    for (key, value) in params {
        let Some(value) = scalar_text(value) else {
            continue;
        };
        url.query_pairs_mut()
            .append_pair(key, &apply_template(&value, &values));
    }
    Ok(url)
}

async fn fetch_html(
    url: &reqwest::Url,
    headers: &HashMap<String, String>,
) -> Result<String, String> {
    let headers = headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<Vec<_>>();
    fetch_text_with_headers(url.clone(), 15 * 1024 * 1024, "HTML 源响应", &headers).await
}

fn parse_catalog(
    html: &str,
    base_url: &reqwest::Url,
    source: &SourceRecord,
    config: &HtmlAdapterConfig,
    page: u32,
    page_size: u32,
) -> Result<CatalogPage, String> {
    let document = Html::parse_document(html);
    let selector = parse_selector(&config.item_selector)?;
    let items = document
        .select(&selector)
        .enumerate()
        .map(|(index, element)| {
            parse_item(
                element,
                base_url.as_str(),
                source,
                &config.fields,
                &format!("{}-{index}", source.key),
            )
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let total = config
        .total_selector
        .as_deref()
        .and_then(|selector| parse_selector(selector).ok())
        .and_then(|selector| document.select(&selector).next())
        .and_then(|element| {
            normalize_text(element.text().collect::<String>())
                .parse()
                .ok()
        })
        .unwrap_or(items.len() as u64);
    Ok(CatalogPage {
        source_key: source.key.clone(),
        items,
        categories: Vec::new(),
        page,
        page_count: ((total as f64 / page_size as f64).ceil() as u32).max(1),
        page_size,
        total,
    })
}

fn parse_item(
    element: ElementRef<'_>,
    base_url: &str,
    source: &SourceRecord,
    fields: &HashMap<String, HtmlFieldSpec>,
    fallback_id: &str,
) -> Result<Option<VodItem>, String> {
    let base_url = reqwest::Url::parse(base_url).map_err(|error| error.to_string())?;
    let raw_id = field_value(element, fields, &["id", "vodId"]);
    let detail_url = field_value(element, fields, &["detailUrl", "detail", "link"])
        .and_then(|value| resolve_link(&base_url, &value))
        .or_else(|| {
            raw_id
                .as_deref()
                .filter(|value| looks_like_link(value))
                .and_then(|value| resolve_link(&base_url, value))
        });
    let id = detail_url
        .as_ref()
        .map(ToString::to_string)
        .or(raw_id)
        .unwrap_or_else(|| fallback_id.to_string());
    let name = field_value(element, fields, &["name", "title", "vodName"]).unwrap_or_default();
    let play_values = field_values(element, fields, &["playUrl", "play_url", "streamUrl"])
        .into_iter()
        .filter_map(|value| resolve_link(&base_url, &value))
        .filter(|url| validate_remote_url(url).is_ok())
        .collect::<Vec<_>>();
    let episodes = play_values
        .into_iter()
        .enumerate()
        .map(|(index, url)| VodEpisode {
            id: format!("{id}-episode-{index}"),
            name: format!("第 {} 集", index + 1),
            url: url.to_string(),
        })
        .collect::<Vec<_>>();
    if name.is_empty() && detail_url.is_none() && episodes.is_empty() {
        return Ok(None);
    }
    Ok(Some(VodItem {
        id: id.clone(),
        source_key: source.key.clone(),
        source_name: source.name.clone(),
        name,
        poster: field_value(element, fields, &["poster", "pic", "cover"])
            .and_then(|value| resolve_link(&base_url, &value))
            .map(|url| url.to_string())
            .unwrap_or_default(),
        description: field_value(element, fields, &["description", "desc", "content"])
            .unwrap_or_default(),
        year: field_value(element, fields, &["year"]).unwrap_or_default(),
        area: field_value(element, fields, &["area"]).unwrap_or_default(),
        categories: field_value(element, fields, &["category", "class"])
            .map(|value| split_categories(&value))
            .unwrap_or_default(),
        actors: field_value(element, fields, &["actor", "actors"])
            .map(|value| split_people(&value))
            .unwrap_or_default(),
        directors: field_value(element, fields, &["director", "directors"])
            .map(|value| split_people(&value))
            .unwrap_or_default(),
        play_lines: if episodes.is_empty() {
            Vec::new()
        } else {
            vec![VodPlayLine {
                id: format!("{id}-line-0"),
                name: field_value(element, fields, &["playLine", "line"])
                    .unwrap_or_else(|| "HTML 播放".to_string()),
                episodes,
            }]
        },
    }))
}

fn field_value(
    element: ElementRef<'_>,
    fields: &HashMap<String, HtmlFieldSpec>,
    names: &[&str],
) -> Option<String> {
    names
        .iter()
        .find_map(|name| fields.get(*name))
        .and_then(|spec| field_values_for_spec(element, spec).into_iter().next())
}

fn field_values(
    element: ElementRef<'_>,
    fields: &HashMap<String, HtmlFieldSpec>,
    names: &[&str],
) -> Vec<String> {
    names
        .iter()
        .find_map(|name| fields.get(*name))
        .map(|spec| field_values_for_spec(element, spec))
        .unwrap_or_default()
}

fn field_values_for_spec(element: ElementRef<'_>, spec: &HtmlFieldSpec) -> Vec<String> {
    let (selector_text, attribute) = match spec {
        HtmlFieldSpec::Selector(selector) => (selector.as_str(), None),
        HtmlFieldSpec::Detailed(config) => (
            config.selector.as_str(),
            config.attr.as_deref().or(config.attribute.as_deref()),
        ),
    };
    let Ok(selector) = Selector::parse(selector_text) else {
        return Vec::new();
    };
    element
        .select(&selector)
        .filter_map(|selected| {
            let value = attribute
                .and_then(|attribute| selected.value().attr(attribute))
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| selected.text().collect::<String>());
            let value = normalize_text(value);
            (!value.is_empty()).then_some(value)
        })
        .collect()
}

fn parse_selector(value: &str) -> Result<Selector, String> {
    Selector::parse(value).map_err(|error| format!("CSS 选择器无效「{value}」：{error}"))
}

fn resolve_link(base_url: &reqwest::Url, value: &str) -> Option<reqwest::Url> {
    if value.starts_with("javascript:") || value.starts_with("data:") {
        return None;
    }
    let url = base_url.join(value).ok()?;
    validate_remote_url(&url).ok()?;
    Some(url)
}

fn looks_like_link(value: &str) -> bool {
    value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
}

fn split_categories(value: &str) -> Vec<VodCategory> {
    value
        .split(['/', ',', '|', '、'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .enumerate()
        .map(|(index, name)| VodCategory {
            id: format!("html-category-{index}"),
            name: name.to_string(),
        })
        .collect()
}

fn split_people(value: &str) -> Vec<String> {
    value
        .split(['/', ',', '|', '、'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn normalize_text(value: String) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

struct HtmlTemplateValues<'a> {
    query: &'a str,
    category_id: &'a str,
    page: u32,
    page_size: u32,
    id: &'a str,
}

fn apply_template(template: &str, values: &HtmlTemplateValues<'_>) -> String {
    template
        .replace("{query}", values.query)
        .replace("{wd}", values.query)
        .replace("{keyword}", values.query)
        .replace("{categoryId}", values.category_id)
        .replace("{category}", values.category_id)
        .replace("{page}", &values.page.to_string())
        .replace("{pageSize}", &values.page_size.to_string())
        .replace("{limit}", &values.page_size.to_string())
        .replace("{id}", values.id)
}

fn validate_html_config(config: &HtmlAdapterConfig) -> Result<(), String> {
    parse_selector(&config.item_selector)?;
    if let Some(selector) = config.total_selector.as_deref() {
        parse_selector(selector)?;
    }
    validate_field_selectors(&config.fields)?;
    if let Some(detail) = &config.detail {
        if let Some(selector) = detail.item_selector.as_deref() {
            parse_selector(selector)?;
        }
        if let Some(fields) = detail.fields.as_ref() {
            validate_field_selectors(fields)?;
        }
    }
    Ok(())
}

fn validate_field_selectors(fields: &HashMap<String, HtmlFieldSpec>) -> Result<(), String> {
    for (name, spec) in fields {
        let selector = match spec {
            HtmlFieldSpec::Selector(selector) => selector,
            HtmlFieldSpec::Detailed(config) => &config.selector,
        };
        parse_selector(selector)
            .map_err(|error| format!("HTML 字段「{name}」配置无效：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_catalog, HtmlAdapterConfig};
    use crate::SourceRecord;

    fn source() -> SourceRecord {
        SourceRecord {
            key: "html".to_string(),
            name: "HTML".to_string(),
            source_type: "cms".to_string(),
            source_dialect: Some("tvbox".to_string()),
            site_type: Some(5),
            site_protocol: Some("html-http".to_string()),
            api: "https://example.com/search".to_string(),
            logo: None,
            description: None,
            nsfw: false,
            status: true,
            ext: None,
            extra: None,
            jar: None,
            epg: None,
            searchable: true,
            filterable: true,
            capability: "supported".to_string(),
            capability_note: "ok".to_string(),
            test_status: None,
            test_message: None,
            tested_at: None,
            test_item_count: None,
            test_category_count: None,
            test_duration_ms: None,
            test_operations: Vec::new(),
            enabled: true,
            last_checked_at: "刚刚".to_string(),
            request_count: 0,
        }
    }

    #[test]
    fn maps_html_cards_to_vod_items_and_relative_links() {
        let config: HtmlAdapterConfig = serde_json::from_str(
            r#"{
              "itemSelector": ".card",
              "fields": {
                "id": {"selector": "a", "attr": "href"},
                "name": ".title",
                "poster": {"selector": "img", "attr": "src"},
                "playUrl": {"selector": "a.play", "attr": "href"},
                "category": ".category"
              }
            }"#,
        )
        .unwrap();
        let page = parse_catalog(
            r#"<main><article class="card"><a href="/detail/1">一部影片</a><h2 class="title">影片一</h2><img src="/poster.jpg"><a class="play" href="/play/1.m3u8">播放</a><span class="category">电影/动作</span></article></main>"#,
            &"https://example.com/search".parse().unwrap(),
            &source(),
            &config,
            1,
            20,
        )
        .unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].name, "影片一");
        assert_eq!(page.items[0].id, "https://example.com/detail/1");
        assert_eq!(page.items[0].poster, "https://example.com/poster.jpg");
        assert_eq!(
            page.items[0].play_lines[0].episodes[0].url,
            "https://example.com/play/1.m3u8"
        );
        assert_eq!(page.items[0].categories.len(), 2);
    }
}
