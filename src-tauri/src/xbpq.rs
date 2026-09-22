//! Declarative adapter for XBPQ / XYQHiker style sources.
//!
//! These sources are common in TVBox configurations and are usually described as needing a
//! "spider" or a downloaded JAR. The configuration they carry, however, is not code: it is a
//! small vocabulary of URL templates and text markers. Measured against the real imported
//! configuration, every one of the 29 distinct keys found across the inline payloads is a
//! selector, a URL, or a delimiter — none is executable. That makes them supportable through the
//! same declarative path as `html-http`, without executing anything, which is what the project's
//! hard constraint requires.
//!
//! The marker vocabulary is a `START&&END` slice rather than a CSS selector: the value is the
//! text between the two markers. `START&&END[不包含:X]` additionally drops slices containing `X`.
//! `数组` is the same shape but is a *separator* — every occurrence delimits one record.
//!
//! Playback is the one part that is not always declarative. When a configuration lists `嗅探词`
//! it expects the player page to be loaded and the stream sniffed out of it, which needs the
//! companion JAR; this adapter does not do that. It extracts direct media URLs when the page
//! embeds them and reports the rest as unavailable rather than inventing a URL.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use crate::{
    cms::{CatalogPage, VodCategory, VodEpisode, VodItem, VodPlayLine},
    policy::{fetch_text_with_headers, validate_remote_url},
    SourceRecord,
};

/// Marker separating the two halves of a `START&&END` slice.
const MARKER_JOIN: &str = "&&";

/// The largest configuration this adapter will read, and the largest listing page it will parse.
const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const MAX_PAGE_BYTES: usize = 15 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Default)]
struct XbpqConfig {
    /// Category display names.
    ///
    /// Two serializations are common in real configurations and both are read: `FREE电影&FREE剧集`
    /// (names only, paired positionally with `分类值`) and `电影$1#电视剧$2` (each entry carries
    /// its own value after `$`). Measured across real config files, the second form is the more
    /// common one — reading it as the first produced a single nonsense category literally named
    /// `电影$1#电视剧$2`.
    #[serde(rename = "分类", default)]
    category_names: Option<String>,
    /// Category ids, when carried separately from the names.
    #[serde(rename = "分类值", default)]
    category_values: Option<String>,
    /// The XYQHiker spelling of the same two fields.
    #[serde(rename = "分类名称", default)]
    category_names_alt: Option<String>,
    #[serde(rename = "分类名称替换词", default)]
    category_values_alt: Option<String>,
    /// Listing URL template.
    #[serde(rename = "分类url", default)]
    category_url: Option<String>,
    /// The XYQHiker spelling of the listing URL.
    #[serde(rename = "分类链接", default)]
    category_url_alt: Option<String>,
    #[serde(rename = "搜索url", default)]
    search_url: Option<String>,
    #[serde(rename = "搜索链接", default)]
    search_url_alt: Option<String>,
    /// Record separator for the listing page.
    #[serde(rename = "数组", default)]
    list_array: Option<String>,
    /// The XYQHiker spelling of the record separator.
    #[serde(rename = "分类列表数组规则", default)]
    list_array_alt: Option<String>,
    /// Record separator for the search page, which these sites often lay out differently.
    #[serde(rename = "搜索数组", default)]
    search_array: Option<String>,
    #[serde(rename = "搜索列表数组规则", default)]
    search_array_alt: Option<String>,
    #[serde(rename = "标题", default)]
    title: Option<String>,
    #[serde(rename = "搜索标题", default)]
    search_title: Option<String>,
    #[serde(rename = "分类片单标题", default)]
    title_alt: Option<String>,
    #[serde(rename = "图片", default)]
    poster: Option<String>,
    #[serde(rename = "搜索图片", default)]
    search_poster: Option<String>,
    #[serde(rename = "分类片单图片", default)]
    poster_alt: Option<String>,
    #[serde(rename = "副标题", default)]
    subtitle: Option<String>,
    #[serde(rename = "详情url", default)]
    detail_url: Option<String>,
    /// Play-line separator on the detail page.
    #[serde(rename = "线路数组", default)]
    line_array: Option<String>,
    #[serde(rename = "线路标题", default)]
    line_title: Option<String>,
    /// Episode separator within a play line.
    #[serde(rename = "播放数组", default)]
    play_array: Option<String>,
    /// The episode list within a play line, for the dialect that names both a container and the
    /// links inside it.
    #[serde(rename = "播放列表", default)]
    play_list: Option<String>,
    #[serde(rename = "播放标题", default)]
    play_title: Option<String>,
    #[serde(rename = "导演", default)]
    director: Option<String>,
    #[serde(rename = "主演", default)]
    actor: Option<String>,
    #[serde(rename = "简介", default)]
    description: Option<String>,
    #[serde(rename = "年份", default)]
    year: Option<String>,
    #[serde(rename = "地区", default)]
    area: Option<String>,
    /// Present when the stream can only be obtained by loading the player page and sniffing it.
    #[serde(rename = "嗅探词", default)]
    sniff_words: Option<String>,
    /// The newer dialect's spelling of the sniff keywords, used when manual sniffing is on.
    #[serde(rename = "手动嗅探视频链接关键词", default)]
    sniff_words_alt: Option<String>,
    /// `Name$Value` pairs, `#`-separated.
    #[serde(rename = "播放请求头", default)]
    play_headers: Option<String>,
    /// The newer dialect's spelling of the same request headers.
    #[serde(rename = "请求头参数", default)]
    play_headers_alt: Option<String>,
    /// Every key present in the payload, including ones this struct does not model.
    ///
    /// Kept so the dialect can be identified: the Jsoup-style sibling shares the `&&` join but
    /// means something different by it, and its distinguishing keys are exactly the ones not
    /// modelled here.
    #[serde(flatten, default)]
    extra_keys: std::collections::HashMap<String, Value>,
}

impl XbpqConfig {
    fn category_url(&self) -> Option<&str> {
        self.category_url
            .as_deref()
            .or(self.category_url_alt.as_deref())
    }

    fn search_url(&self) -> Option<&str> {
        self.search_url
            .as_deref()
            .or(self.search_url_alt.as_deref())
    }

    fn list_array(&self) -> Option<&str> {
        self.list_array
            .as_deref()
            .or(self.list_array_alt.as_deref())
    }

    fn search_array(&self) -> Option<&str> {
        self.search_array
            .as_deref()
            .or(self.search_array_alt.as_deref())
    }

    fn title(&self) -> Option<&str> {
        self.title
            .as_deref()
            .or(self.search_title.as_deref())
            .or(self.title_alt.as_deref())
    }

    fn poster(&self) -> Option<&str> {
        self.poster
            .as_deref()
            .or(self.search_poster.as_deref())
            .or(self.poster_alt.as_deref())
    }

    fn sniff_words(&self) -> Option<&str> {
        self.sniff_words
            .as_deref()
            .or(self.sniff_words_alt.as_deref())
    }

    fn play_headers(&self) -> Option<&str> {
        self.play_headers
            .as_deref()
            .or(self.play_headers_alt.as_deref())
    }

    /// Whether this configuration is written in the Jsoup-selector dialect instead.
    ///
    /// That dialect is identified by its own key names (`分类列表数组规则`, `分类片单标题`, …) and
    /// by selector values that are CSS/Jsoup expressions rather than literal text markers. Both
    /// dialects spell their joins `&&`, so the keys are the reliable discriminator.
    fn uses_jsoup_selectors(&self) -> bool {
        const JSOUP_KEYS: [&str; 6] = [
            "分类列表数组规则",
            "分类片单标题",
            "分类片单链接",
            "分类片单是否Jsoup写法",
            "选集标题",
            "选集链接",
        ];
        self.extra_keys
            .keys()
            .any(|key| JSOUP_KEYS.contains(&key.as_str()))
    }
}

/// A parsed `START&&END[FILTER]` marker.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Marker {
    start: String,
    end: Option<String>,
    /// Drop slices whose body contains this text.
    exclude: Option<String>,
    /// Keep only slices whose body contains this text.
    include: Option<String>,
}

impl Marker {
    /// Parses a marker specification. Returns `None` for an empty specification so callers can
    /// treat "not configured" and "configured but unusable" the same way.
    fn parse(spec: &str) -> Option<Self> {
        let spec = spec.trim();
        if spec.is_empty() {
            return None;
        }
        // A trailing `[包含:x]` / `[不包含:x]` filter applies to the slices.
        let (body, filter) = match spec.rfind('[') {
            Some(at) if spec.ends_with(']') => {
                let inner = &spec[at + 1..spec.len() - 1];
                (&spec[..at], Some(inner))
            }
            _ => (spec, None),
        };
        let (start, end) = match body.find(MARKER_JOIN) {
            Some(at) => (
                body[..at].to_string(),
                Some(body[at + MARKER_JOIN.len()..].to_string()),
            ),
            None => (body.to_string(), None),
        };
        if start.is_empty() {
            return None;
        }
        let (mut exclude, mut include) = (None, None);
        if let Some(filter) = filter {
            if let Some(value) = filter.strip_prefix("不包含:") {
                exclude = Some(value.trim().to_string());
            } else if let Some(value) = filter.strip_prefix("包含:") {
                include = Some(value.trim().to_string());
            }
        }
        Some(Self {
            start,
            end: end.filter(|value| !value.is_empty()),
            exclude: exclude.filter(|value| !value.is_empty()),
            include: include.filter(|value| !value.is_empty()),
        })
    }

    /// Every slice this marker delimits, in document order.
    ///
    /// A marker without an end half yields one slice running to the end of the document, which is
    /// what a "everything after this point" marker means.
    fn slices<'a>(&self, html: &'a str) -> Vec<&'a str> {
        let mut out = Vec::new();
        let mut cursor = 0usize;
        while let Some(found) = html[cursor..].find(&self.start) {
            let body_start = cursor + found + self.start.len();
            let body_end = match self.end.as_deref() {
                Some(end) => match html[body_start..].find(end) {
                    Some(offset) => body_start + offset,
                    None => break,
                },
                None => html.len(),
            };
            let body = &html[body_start..body_end];
            // `is_none_or` would read better but is newer than this crate's MSRV.
            let keep = self
                .exclude
                .as_deref()
                .map_or(true, |value| !body.contains(value))
                && self
                    .include
                    .as_deref()
                    .map_or(true, |value| body.contains(value));
            if keep {
                out.push(body);
            }
            cursor = if body_end > body_start {
                body_end
            } else {
                body_start.max(cursor + 1)
            };
            if cursor >= html.len() {
                break;
            }
        }
        out
    }

    /// The first slice, which is what a single-value marker wants.
    fn first(&self, html: &str) -> Option<String> {
        self.slices(html).into_iter().next().map(clean_text)
    }
}

/// Collapses whitespace and strips the tags a marker slice usually still carries.
fn clean_text(value: &str) -> String {
    let without_tags = strip_tags(value);
    without_tags.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Removes tags, keeping their text. Used because these markers slice raw HTML and the value is
/// conventionally the text inside the element the markers bound.
fn strip_tags(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut depth = 0usize;
    for character in value.chars() {
        match character {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(character),
            _ => {}
        }
    }
    out
}

/// The XBPQ listing template vocabulary. `{cateId}` / `{catePg}` are the documented ones; the
/// others are accepted because they appear in the wider ecosystem and cost nothing to support.
fn apply_template(template: &str, values: &TemplateValues<'_>) -> String {
    template
        .replace("{cateId}", values.category_id)
        .replace("{catePg}", &values.page.to_string())
        .replace("{catePage}", &values.page.to_string())
        .replace("{page}", &values.page.to_string())
        .replace("{area}", values.area)
        .replace("{year}", values.year)
        .replace("{by}", values.sort)
        .replace("{wd}", values.query)
        .replace("{keyword}", values.query)
        .replace("{searchPg}", &values.page.to_string())
        .replace("{id}", values.id)
}

struct TemplateValues<'a> {
    category_id: &'a str,
    page: u32,
    area: &'a str,
    year: &'a str,
    sort: &'a str,
    query: &'a str,
    id: &'a str,
}

impl Default for TemplateValues<'_> {
    fn default() -> Self {
        Self {
            category_id: "",
            page: 1,
            area: "",
            year: "",
            sort: "",
            query: "",
            id: "",
        }
    }
}

/// Loads the configuration. `ext` is either the JSON itself or a URL serving it, which is the
/// more common arrangement: of the real payloads inspected, 4 were inline and 64 were URLs.
///
/// Two serializations of the same vocabulary are accepted. Most sources use JSON. `csp_Panda`
/// uses `key:value` pairs joined by `,` — the same keys with the same meanings, e.g.
/// `分类url:http://…/{cateId}/{catePg}.html,分类:快手$2#抖音$3`. Treating that as a different
/// feature would be a distinction without a difference, so both are parsed into one struct.
async fn load_config(source: &SourceRecord) -> Result<XbpqConfig, String> {
    let raw = source
        .ext
        .as_deref()
        .or(source.extra.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "该 XBPQ 源没有携带配置（ext 为空）。".to_string())?;

    // Either the JSON is inline, or the `key:value` form is, or `raw` is a URL to fetch.
    let inline = raw.starts_with('{') || raw.starts_with('[') || looks_like_pair_config(raw);
    let text = if inline {
        raw.to_string()
    } else {
        let url = reqwest::Url::parse(raw)
            .map_err(|error| format!("XBPQ 配置地址无效「{raw}」：{error}"))?;
        validate_remote_url(&url)?;
        fetch_text_with_headers(url, MAX_CONFIG_BYTES, "XBPQ 配置", &[]).await?
    };

    let trimmed = text.trim();
    let value: Value = if trimmed.starts_with('{') || trimmed.starts_with('[') {
        serde_json::from_str(trimmed).map_err(|error| format!("XBPQ 配置不是有效 JSON：{error}"))?
    } else {
        pair_config_to_value(trimmed)?
    };
    let config: XbpqConfig =
        serde_json::from_value(value).map_err(|error| format!("XBPQ 配置字段无效：{error}"))?;

    // A sibling dialect describes its pages with Jsoup selectors (`a&&href`, `.sTit&&Text`,
    // `body&&span:contains(年代：)`) rather than the text markers this adapter reads. The two look
    // superficially similar — both use `&&` — but mean different things, so reading a Jsoup rule
    // as a marker yields silent nonsense rather than an error. Detecting it here turns that into
    // an honest failure.
    if config.uses_jsoup_selectors() {
        return Err(
            "该源使用 Jsoup 选择器方言（如 a&&href、.sTit&&Text），与本文本标记方言不同，当前不支持。"
                .to_string(),
        );
    }
    Ok(config)
}

/// Whether a raw `ext` is the inline `key:value,key:value` form rather than a URL.
///
/// The test is deliberately narrow: it requires a known vocabulary key followed by `:` before any
/// `,` or `/`. A URL never matches because its scheme's `:` is not preceded by a key name, and
/// requiring a known key keeps an unrecognised payload from being silently misread as config.
fn looks_like_pair_config(raw: &str) -> bool {
    let head = raw.split(',').next().unwrap_or_default();
    let Some((key, _)) = head.split_once(':') else {
        return false;
    };
    let key = key.trim();
    if key.is_empty() || key.contains('/') || key.contains(' ') {
        return false;
    }
    const KNOWN_KEYS: [&str; 12] = [
        "分类url",
        "搜索url",
        "分类",
        "分类值",
        "数组",
        "搜索数组",
        "标题",
        "图片",
        "线路数组",
        "播放数组",
        "简介",
        "嗅探词",
    ];
    KNOWN_KEYS.contains(&key)
}

/// Converts the `key:value,key:value` form into the same JSON object the serde struct expects.
///
/// Splitting on `,` is safe because the values in this form never contain a bare comma: category
/// lists use `&`, and play-header lists use `#`.
fn pair_config_to_value(raw: &str) -> Result<Value, String> {
    let mut object = serde_json::Map::new();
    for pair in raw.split(',') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let Some((key, value)) = pair.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        object.insert(
            key.to_string(),
            Value::String(value.trim().to_string()),
        );
    }
    if object.is_empty() {
        return Err("XBPQ 配置没有可识别的字段。".to_string());
    }
    Ok(Value::Object(object))
}

/// The category list, from whichever of the two serializations the configuration uses.
///
/// Real configurations use both, and they are not interchangeable:
///
/// * `分类: "电影&电视剧"` + `分类值: "1&2"` — names and values in two parallel lists.
/// * `分类: "电影$1#电视剧$2"` — each entry carries its own value after `$`, `#`-separated.
///
/// The second is the more common one across the real files inspected. Reading it with the first
/// rule produced a single category whose name was the entire string, so both are detected here.
fn categories(config: &XbpqConfig) -> Vec<VodCategory> {
    let names = config
        .category_names
        .as_deref()
        .or(config.category_names_alt.as_deref())
        .unwrap_or_default();
    if names.trim().is_empty() {
        return Vec::new();
    }

    // The `name$value#name$value` form: a `$` in any entry means each entry is self-describing.
    if names.contains('$') {
        return names
            .split('#')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .enumerate()
            .map(|(index, entry)| match entry.split_once('$') {
                Some((name, value)) => VodCategory {
                    id: value.trim().to_string(),
                    name: name.trim().to_string(),
                },
                None => VodCategory {
                    id: (index + 1).to_string(),
                    name: entry.to_string(),
                },
            })
            .filter(|category| !category.name.is_empty())
            .collect();
    }

    // The parallel-list form. `&` separates entries in both lists.
    let values = config
        .category_values
        .as_deref()
        .or(config.category_values_alt.as_deref())
        .unwrap_or_default();
    let values: Vec<&str> = values
        .split(['&', '#'])
        .map(str::trim)
        .collect();
    names
        .split(['&', '#'])
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .enumerate()
        .map(|(index, name)| VodCategory {
            id: values
                .get(index)
                .filter(|value| !value.is_empty())
                .map(|value| (*value).to_string())
                .unwrap_or_else(|| (index + 1).to_string()),
            name: name.to_string(),
        })
        .collect()
}

/// Headers to send when fetching this source's pages.
///
/// These sites routinely reject non-browser clients, and the configuration's `播放请求头` field
/// already names the user agent the source expects. Reusing it for the HTML requests is both
/// what makes the pages load at all and consistent with the author's intent.
fn page_headers(config: &XbpqConfig) -> Vec<(String, String)> {
    let headers = play_headers(config.play_headers());
    let mut out: Vec<(String, String)> = headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    if !out
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("user-agent"))
    {
        out.push((
            "User-Agent".to_string(),
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36".to_string(),
        ));
    }
    out
}

pub(crate) async fn browse_source(
    source: SourceRecord,
    query: String,
    category_id: Option<String>,
    page: u32,
    page_size: u32,
) -> Result<CatalogPage, String> {
    let config = load_config(&source).await?;
    let searching = !query.trim().is_empty();

    let template = if searching {
        config.search_url().or(config.category_url())
    } else {
        config.category_url()
    }
    .ok_or_else(|| "该 XBPQ 源没有配置可用的列表地址（分类url / 搜索url）。".to_string())?;

    let values = TemplateValues {
        category_id: category_id.as_deref().unwrap_or_default(),
        page,
        query: query.trim(),
        ..Default::default()
    };
    let url = reqwest::Url::parse(&apply_template(template, &values))
        .map_err(|error| format!("XBPQ 列表地址无效：{error}"))?;
    validate_remote_url(&url)?;
    let html = fetch_text_with_headers(
        url.clone(),
        MAX_PAGE_BYTES,
        "XBPQ 列表页",
        &page_headers(&config),
    )
    .await?;

    // The search page frequently has its own record separator; fall back to the listing one.
    let array = if searching {
        config.search_array().or(config.list_array())
    } else {
        config.list_array()
    }
    .and_then(Marker::parse);

    let items = match &array {
        Some(marker) => marker
            .slices(&html)
            .into_iter()
            .enumerate()
            .filter_map(|(index, segment)| parse_list_item(segment, &url, &source, &config, index))
            .collect::<Vec<_>>(),
        // No record separator configured. A real imported configuration omits it and relies on
        // its runtime's default, so rather than refusing the source the records are taken from
        // the detail links on the page — which is what the separator is there to delimit. The
        // card for each link is the smallest enclosing element, approximated by the text between
        // one link and the next.
        None => parse_items_without_separator(&html, &url, &source, &config),
    };

    let total = items.len() as u64;
    Ok(CatalogPage {
        source_key: source.key.clone(),
        items,
        categories: categories(&config),
        page,
        page_count: if total == 0 {
            1
        } else {
            ((total as f64 / page_size.max(1) as f64).ceil() as u32).max(1)
        },
        page_size,
        total,
    })
}

/// Reads listing records when the configuration supplies no record separator.
///
/// The separator's job is to bound one card. Without it, the cards are reconstructed around the
/// detail links themselves: each link starts a record that runs to the next detail link. That is
/// enough for the fields a listing actually carries (title, poster, the link), because those all
/// sit adjacent to the link inside the same card.
fn parse_items_without_separator(
    html: &str,
    base_url: &reqwest::Url,
    source: &SourceRecord,
    config: &XbpqConfig,
) -> Vec<VodItem> {
    // Positions of every `<a ` tag, so records can be cut at link boundaries.
    let mut anchors: Vec<usize> = Vec::new();
    let mut cursor = 0usize;
    while let Some(found) = html[cursor..].find("<a ") {
        let at = cursor + found;
        anchors.push(at);
        cursor = at + 3;
        if cursor >= html.len() {
            break;
        }
    }
    if anchors.is_empty() {
        return Vec::new();
    }

    let mut items = Vec::new();
    let mut index = 0usize;
    for (position, start) in anchors.iter().enumerate() {
        // A record begins slightly before its link (the card's opening tag) and ends at the next
        // link. Extending backwards keeps the poster, which precedes the link in these layouts.
        let begin = html[..*start]
            .rfind('<')
            .map(|at| html[..at].rfind('<').unwrap_or(at))
            .unwrap_or(*start);
        let end = anchors.get(position + 1).copied().unwrap_or(html.len());
        let segment = &html[begin..end];
        if let Some(item) = parse_list_item(segment, base_url, source, config, index) {
            // Only records that resolve to a detail link are kept, which filters out the nav and
            // footer links that would otherwise each look like a record.
            if is_detail_link(&item.id) {
                items.push(item);
                index += 1;
            }
        }
    }
    items
}

fn parse_list_item(
    segment: &str,
    base_url: &reqwest::Url,
    source: &SourceRecord,
    config: &XbpqConfig,
    index: usize,
) -> Option<VodItem> {
    let name = config
        .title
        .as_deref()
        .and_then(Marker::parse)
        .and_then(|marker| marker.first(segment))
        .unwrap_or_default();

    // The detail link is what identifies the record; without it the item cannot be opened.
    //
    // Some listings carry no link at all and expect the id to be interpolated into `详情url`
    // instead, so that template is the fallback rather than a second source of truth.
    let detail = extract_links(segment, base_url)
        .into_iter()
        .find(|url| is_detail_link(url.as_str()))
        .or_else(|| extract_links(segment, base_url).into_iter().next())
        .or_else(|| {
            let template = config.detail_url.as_deref()?;
            let id = config
                .title
                .as_deref()
                .and_then(Marker::parse)
                .and_then(|marker| marker.first(segment))?;
            let id = attribute_of_first_link(segment).unwrap_or(id);
            let url = apply_template(
                template,
                &TemplateValues {
                    id: &id,
                    ..Default::default()
                },
            );
            resolve(base_url, &url)
        })?;

    if name.is_empty() && segment.trim().is_empty() {
        return None;
    }

    let poster = config
        .poster
        .as_deref()
        .and_then(Marker::parse)
        .and_then(|marker| marker.first(segment))
        .and_then(|value| resolve(base_url, &value))
        .map(|url| url.to_string())
        .unwrap_or_default();

    Some(VodItem {
        id: detail.to_string(),
        source_key: source.key.clone(),
        source_name: source.name.clone(),
        name: if name.is_empty() {
            format!("{} #{}", source.name, index + 1)
        } else {
            name
        },
        poster,
        // A listing card carries no synopsis; the only descriptive text on it is the note the
        // config points `副标题` at (conventionally "更新至 12 集"). The detail request replaces
        // this with the real synopsis, so using it here is strictly better than an empty field.
        description: config
            .subtitle
            .as_deref()
            .and_then(Marker::parse)
            .and_then(|marker| marker.first(segment))
            .unwrap_or_default(),
        year: String::new(),
        area: String::new(),
        categories: Vec::new(),
        actors: Vec::new(),
        directors: Vec::new(),
        // Listing pages do not carry playable URLs; they are resolved from the detail page.
        play_lines: Vec::new(),
    })
}

/// Splits the `嗅探词` field into its tokens.
///
/// The field is a `#`-separated list of fragments that identify a playable URL — real examples
/// include `m3u8#.m3u8#.mp4#freeok.mp4#/obj/`. Some entries are extensions (`.m3u8`) and some are
/// host or path fragments (`/obj/`), so the list is matched as "the URL contains one of these".
fn sniff_tokens(config: &XbpqConfig) -> Vec<String> {
    config
        .sniff_words()
        .unwrap_or_default()
        .split('#')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_lowercase())
        .collect()
}

/// Every media-looking URL embedded in the page, found without executing anything.
///
/// This is the declarative reading of `嗅探词`: the config says which fragments identify a
/// stream, so the URLs are located by scanning the page's own text for those fragments rather
/// than by loading the player page and watching its network traffic. It finds the streams these
/// pages embed directly, which is the common case; it does not find one that only appears after
/// the page's own scripts run, and in that case the episode keeps its page URL and fails with a
/// message instead of a fabricated address.
///
/// The scanning primitives live in [`crate::page_stream`] because the resolver needs exactly the
/// same technique for CMS episodes whose address is a player page. Two copies of a scanner would
/// drift, and the drift would show up as "this source works in one place but not the other".
fn sniff_media_urls(html: &str, base_url: &reqwest::Url, tokens: &[String]) -> Vec<String> {
    crate::page_stream::media_urls_matching(html, base_url, tokens)
}

pub(crate) async fn get_detail(
    source: SourceRecord,
    vod_id: String,
) -> Result<Option<VodItem>, String> {
    let config = load_config(&source).await?;
    let url = reqwest::Url::parse(&vod_id)
        .map_err(|error| format!("XBPQ 详情地址无效「{vod_id}」：{error}"))?;
    validate_remote_url(&url)?;
    let html = fetch_text_with_headers(
        url.clone(),
        MAX_PAGE_BYTES,
        "XBPQ 详情页",
        &page_headers(&config),
    )
    .await?;

    let field = |spec: &Option<String>| -> String {
        spec.as_deref()
            .and_then(Marker::parse)
            .and_then(|marker| marker.first(&html))
            .unwrap_or_default()
    };

    let name = field(&config.title().map(ToOwned::to_owned));
    let description = field(&config.description);
    let year = field(&config.year);
    let area = field(&config.area);

    let play_lines = parse_play_lines(&html, &url, &source, &config, &vod_id);
    if name.is_empty() && play_lines.is_empty() {
        return Ok(None);
    }

    Ok(Some(VodItem {
        id: vod_id.clone(),
        source_key: source.key.clone(),
        source_name: source.name.clone(),
        name,
        poster: config
            .poster()
            .and_then(Marker::parse)
            .and_then(|marker| marker.first(&html))
            .and_then(|value| resolve(&url, &value))
            .map(|value| value.to_string())
            .unwrap_or_default(),
        description,
        year,
        area,
        categories: Vec::new(),
        actors: split_people(&field(&config.actor)),
        directors: split_people(&field(&config.director)),
        play_lines,
    }))
}

/// Builds the play lines from the detail page.
///
/// The line separator (`线路数组`) delimits one line each; within a line every link that looks
/// like an episode becomes an episode.
///
/// Episode targets prefer a real stream address: any URL on the page matching the config's
/// `嗅探词` tokens is a direct media URL, and those are what the player can actually open. When a
/// line has no such URL the episodes keep their page link, which the resolver may still be able
/// to turn into a stream through a configured parse service. Only when neither works does an
/// episode fail — and it fails with the URL it has, not an invented one.
fn parse_play_lines(
    html: &str,
    base_url: &reqwest::Url,
    source: &SourceRecord,
    config: &XbpqConfig,
    vod_id: &str,
) -> Vec<VodPlayLine> {
    let line_marker = config.line_array.as_deref().and_then(Marker::parse);
    let segments: Vec<&str> = match &line_marker {
        Some(marker) => marker.slices(html),
        None => vec![html],
    };
    let tokens = sniff_tokens(config);
    // Streams found on the page, offered to lines that have no address of their own. The first
    // line gets the first stream, the second line the second, and so on — which matches how
    // these pages list one playable address per line.
    let page_streams = sniff_media_urls(html, base_url, &tokens);

    let mut lines = Vec::new();
    let mut used_streams = 0usize;
    for (line_index, segment) in segments.iter().enumerate() {
        let title = config
            .line_title
            .as_deref()
            .and_then(Marker::parse)
            .and_then(|marker| marker.first(segment))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("线路 {}", line_index + 1));

        let mut episodes = parse_episodes(segment, base_url, config, vod_id, line_index);

        // A line whose episodes point at the page rather than a stream, but which has a sniffed
        // stream available, takes that stream.
        let has_stream = episodes.iter().any(|episode| {
            let lowered = episode.url.to_ascii_lowercase();
            tokens.iter().any(|token| lowered.contains(token.as_str()))
        });
        if !has_stream && !episodes.is_empty() {
            if let Some(stream) = page_streams.get(used_streams) {
                used_streams += 1;
                episodes = vec![VodEpisode {
                    id: format!("{vod_id}-{line_index}-0"),
                    name: title.clone(),
                    url: stream.clone(),
                }];
            }
        }

        if episodes.is_empty() {
            continue;
        }
        lines.push(VodPlayLine {
            id: format!("{vod_id}-line-{line_index}"),
            name: title,
            episodes,
        });
    }

    if lines.is_empty() {
        // No line separator configured, or no segment produced episodes: fall back to the whole
        // page, preferring a sniffed stream over a page link.
        let episodes = if let Some(stream) = page_streams.first() {
            vec![VodEpisode {
                id: format!("{vod_id}-0-0"),
                name: source.name.clone(),
                url: stream.clone(),
            }]
        } else {
            parse_episodes(html, base_url, config, vod_id, 0)
        };
        if !episodes.is_empty() {
            lines.push(VodPlayLine {
                id: format!("{vod_id}-line-0"),
                name: source.name.clone(),
                episodes,
            });
        }
    }
    lines
}

fn parse_episodes(
    segment: &str,
    base_url: &reqwest::Url,
    config: &XbpqConfig,
    vod_id: &str,
    line_index: usize,
) -> Vec<VodEpisode> {
    // `播放列表` narrows the region to search when it is configured: it bounds the element that
    // holds the episode links, so the scan does not pick up unrelated links (navigation, ads)
    // from elsewhere in the same segment. Real configs pair it with `播放数组`.
    let scoped = config
        .play_list
        .as_deref()
        .and_then(Marker::parse)
        .and_then(|marker| marker.slices(segment).into_iter().next())
        .unwrap_or(segment);

    // An explicit episode separator is authoritative when configured.
    if let Some(marker) = config.play_array.as_deref().and_then(Marker::parse) {
        let episodes = marker
            .slices(scoped)
            .into_iter()
            .enumerate()
            .filter_map(|(index, slice)| {
                let url = extract_links(slice, base_url).into_iter().next()?;
                // `播放标题` names the element holding the episode label when it is configured;
                // otherwise the anchor's own text is the best available label.
                let name = config
                    .play_title
                    .as_deref()
                    .and_then(Marker::parse)
                    .and_then(|title| title.first(slice))
                    .filter(|text| !text.is_empty())
                    .or_else(|| {
                        extract_links_with_text(slice, base_url)
                            .into_iter()
                            .find(|(candidate, _)| candidate == &url)
                            .map(|(_, text)| text)
                            .filter(|text| !text.is_empty())
                    })
                    .unwrap_or_else(|| format!("第 {} 集", index + 1));
                Some(VodEpisode {
                    id: format!("{vod_id}-{line_index}-{index}"),
                    name,
                    url: url.to_string(),
                })
            })
            .collect::<Vec<_>>();
        if !episodes.is_empty() {
            return episodes;
        }
    }

    // Otherwise every episode link in the segment is one episode, which is how these sites
    // normally lay the selector out.
    extract_links_with_text(scoped, base_url)
        .into_iter()
        .enumerate()
        .filter(|(_, (url, _))| is_episode_link(url.as_str()))
        .map(|(index, (url, text))| VodEpisode {
            id: format!("{vod_id}-{line_index}-{index}"),
            name: if text.is_empty() {
                format!("第 {} 集", index + 1)
            } else {
                text
            },
            url: url.to_string(),
        })
        .collect()
}

fn is_detail_link(url: &str) -> bool {
    let lowered = url.to_ascii_lowercase();
    lowered.contains("/voddetail/")
        || lowered.contains("/detail/")
        || lowered.contains("/vod/")
        || lowered.contains("voddetail")
}

fn is_episode_link(url: &str) -> bool {
    let lowered = url.to_ascii_lowercase();
    lowered.contains("/vodplay/")
        || lowered.contains("/play/")
        || lowered.contains(".m3u8")
        || lowered.contains(".mp4")
}

/// Resolves a possibly relative link against the page, refusing non-remote schemes.
fn resolve(base_url: &reqwest::Url, value: &str) -> Option<reqwest::Url> {
    let value = value.trim();
    if value.is_empty() || value.starts_with("javascript:") || value.starts_with("data:") {
        return None;
    }
    let url = base_url.join(value).ok()?;
    validate_remote_url(&url).ok()?;
    Some(url)
}

/// Every `<a href>` in the fragment, resolved.
fn extract_links(segment: &str, base_url: &reqwest::Url) -> Vec<reqwest::Url> {
    extract_links_with_text(segment, base_url)
        .into_iter()
        .map(|(url, _)| url)
        .collect()
}

/// Every `<a href="...">text</a>` in the fragment, resolved and paired with its text.
fn extract_links_with_text(segment: &str, base_url: &reqwest::Url) -> Vec<(reqwest::Url, String)> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(found) = segment[cursor..].find("<a ") {
        let tag_start = cursor + found;
        let Some(tag_end) = segment[tag_start..].find('>').map(|at| tag_start + at) else {
            break;
        };
        let tag = &segment[tag_start..tag_end];
        let href = attribute(tag, "href");
        let text = match segment[tag_end..].find("</a>") {
            Some(close) => clean_text(&segment[tag_end + 1..tag_end + close]),
            None => String::new(),
        };
        if let Some(href) = href {
            if let Some(url) = resolve(base_url, &href) {
                out.push((url, text));
            }
        }
        cursor = tag_end + 1;
        if cursor >= segment.len() {
            break;
        }
    }
    out
}

/// Reads one attribute out of a tag's text, tolerating both quote styles.
fn attribute(tag: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        if let Some(at) = tag.find(&needle) {
            let rest = &tag[at + needle.len()..];
            if let Some(end) = rest.find(quote) {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

/// The id carried by the first link in a fragment, taken from a `data-id` style attribute when
/// present. Used only when a listing supplies no detail link but does configure `详情url`.
fn attribute_of_first_link(segment: &str) -> Option<String> {
    let at = segment.find("<a ")?;
    let end = segment[at..].find('>').map(|offset| at + offset)?;
    let tag = &segment[at..end];
    for name in ["data-id", "data-vod-id", "data-idx", "id"] {
        if let Some(value) = attribute(tag, name) {
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn split_people(value: &str) -> Vec<String> {
    value
        .split(['/', ',', '|', '、', '&'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// Header map from the `播放请求头` field, which is `Name$Value` pairs joined by `#`.
pub(crate) fn play_headers(config_text: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(text) = config_text else {
        return out;
    };
    for pair in text.split('#') {
        if let Some((name, value)) = pair.split_once('$') {
            let name = name.trim();
            let value = value.trim();
            if !name.is_empty() && !value.is_empty() {
                out.insert(name.to_string(), value.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{categories, parse_list_item, play_headers, Marker, XbpqConfig};

    /// The real configuration of the `fok` source, taken verbatim from the imported config.
    const REAL_CONFIG: &str = r#"{
      "分类url": "https://www.freeok.vip/vod-show/{cateId}-{area}-------{catePg}---{year}.html",
      "分类": "FREE电影&FREE剧集&FREE动漫&FREE综艺&FREE短剧&FREE少儿",
      "分类值": "1&2&3&4&12&5",
      "播放请求头": "User-Agent$Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
      "副标题": "<div class=\"module-item-note\">&&</div>",
      "嗅探词": "m3u8#.m3u8#.mp4#freeok.mp4#/obj/",
      "线路数组": "data-dropdown-value=&&</div>[不包含:夸克]",
      "线路标题": "<span>&&</small>",
      "导演": "导演：&&</div>",
      "主演": "主演：&&</div>",
      "简介": "<p>&&</p>"
    }"#;

    fn real_config() -> XbpqConfig {
        serde_json::from_str(REAL_CONFIG).unwrap()
    }

    #[test]
    fn parses_the_two_halves_of_a_marker() {
        let marker = Marker::parse("<div class=\"module-item-note\">&&</div>").unwrap();

        assert_eq!(marker.start, "<div class=\"module-item-note\">");
        assert_eq!(marker.end.as_deref(), Some("</div>"));
        assert_eq!(marker.exclude, None);
    }

    #[test]
    fn parses_a_marker_without_an_end_half() {
        let marker = Marker::parse("播放地址").unwrap();

        assert_eq!(marker.start, "播放地址");
        assert_eq!(marker.end, None);
    }

    #[test]
    fn parses_an_exclusion_filter() {
        let marker = Marker::parse("data-dropdown-value=&&</div>[不包含:夸克]").unwrap();

        assert_eq!(marker.start, "data-dropdown-value=");
        assert_eq!(marker.end.as_deref(), Some("</div>"));
        assert_eq!(marker.exclude.as_deref(), Some("夸克"));
    }

    #[test]
    fn drops_slices_the_filter_excludes() {
        let marker = Marker::parse("line=&&;").unwrap();
        let html = "line=一号;line=夸克专线;line=二号;";

        assert_eq!(marker.slices(html), vec!["一号", "夸克专线", "二号"]);

        let filtered = Marker::parse("line=&&;[不包含:夸克]").unwrap();
        assert_eq!(filtered.slices(html), vec!["一号", "二号"]);
    }

    #[test]
    fn keeps_only_slices_the_include_filter_matches() {
        let marker = Marker::parse("line=&&;[包含:专线]").unwrap();
        let html = "line=一号;line=夸克专线;line=二号;";

        assert_eq!(marker.slices(html), vec!["夸克专线"]);
    }

    #[test]
    fn rejects_a_marker_with_no_start_half() {
        // `&&` alone would make every position in the document a match. An empty start is
        // rejected outright rather than handled, because there is no meaningful reading of it.
        assert!(Marker::parse("&&").is_none());
        assert!(Marker::parse("").is_none());
        assert!(Marker::parse("   ").is_none());
    }

    #[test]
    fn terminates_when_the_end_half_is_immediately_present() {
        // Degenerate but reachable: an end marker that matches at once must not spin.
        let marker = Marker::parse("x&&y").unwrap();

        assert_eq!(marker.slices("xyxy"), vec!["", ""]);
        assert!(marker.slices("").is_empty());
    }

    #[test]
    fn strips_tags_from_a_marker_slice() {
        let marker = Marker::parse("<div class=\"module-item-note\">&&</div>").unwrap();

        assert_eq!(
            marker.first("<div class=\"module-item-note\">更新至 12 集</div>"),
            Some("更新至 12 集".to_string())
        );
    }

    #[test]
    fn reads_the_category_pairs_positionally() {
        let categories = categories(&real_config());

        assert_eq!(categories.len(), 6);
        assert_eq!(categories[0].id, "1");
        assert_eq!(categories[0].name, "FREE电影");
        // The last pair is deliberately non-sequential, so a positional read is required.
        assert_eq!(categories[5].id, "5");
        assert_eq!(categories[5].name, "FREE少儿");
    }

    #[test]
    fn reads_the_self_describing_category_form() {
        // The form most real configs use: each entry carries its own value after `$`, so there is
        // no parallel `分类值` list. Reading this with the parallel-list rule produced one
        // category literally named "电影$1#电视剧$2#综艺$3".
        let config: XbpqConfig =
            serde_json::from_str(r#"{"分类":"电影$1#电视剧$2#综艺$3#动漫$4"}"#).unwrap();
        let categories = categories(&config);

        assert_eq!(categories.len(), 4);
        assert_eq!(categories[0].id, "1");
        assert_eq!(categories[0].name, "电影");
        assert_eq!(categories[3].id, "4");
        assert_eq!(categories[3].name, "动漫");
    }

    #[test]
    fn reads_the_non_numeric_values_the_self_describing_form_carries() {
        // Real values are often slugs rather than numbers.
        let config: XbpqConfig =
            serde_json::from_str(r#"{"分类":"国产剧$guochanju#动作片$dongzuopian"}"#).unwrap();
        let categories = categories(&config);

        assert_eq!(categories[0].id, "guochanju");
        assert_eq!(categories[1].id, "dongzuopian");
    }

    #[test]
    fn reads_the_xyqhiker_category_spellings() {
        // The sibling dialect names the same two fields differently.
        let config: XbpqConfig =
            serde_json::from_str(r#"{"分类名称":"电影&电视剧&综艺","分类名称替换词":"1&2&3"}"#).unwrap();
        let categories = categories(&config);

        assert_eq!(categories.len(), 3);
        assert_eq!(categories[0].id, "1");
        assert_eq!(categories[2].name, "综艺");
    }

    #[test]
    fn resolves_the_xyqhiker_spelling_of_every_shared_field() {
        // Each accessor must fall back to the sibling dialect's name, or a source written in
        // that dialect silently loses the field.
        let config: XbpqConfig = serde_json::from_str(
            r#"{
              "分类链接": "https://example.com/list/{cateId}/{catePg}.html",
              "搜索链接": "https://example.com/search?wd={wd}",
              "分类列表数组规则": "class=\"card\"&&</div>",
              "搜索列表数组规则": "class=\"hit\"&&</div>",
              "分类片单标题": "alt=\"&&\"",
              "搜索图片": "data-src=\"&&\"",
              "手动嗅探视频链接关键词": ".m3u8#.mp4",
              "请求头参数": "User-Agent$UA/1.0"
            }"#,
        )
        .unwrap();

        assert_eq!(
            config.category_url(),
            Some("https://example.com/list/{cateId}/{catePg}.html")
        );
        assert_eq!(
            config.search_url(),
            Some("https://example.com/search?wd={wd}")
        );
        assert_eq!(config.list_array(), Some("class=\"card\"&&</div>"));
        assert_eq!(config.search_array(), Some("class=\"hit\"&&</div>"));
        assert_eq!(config.title(), Some("alt=\"&&\""));
        assert_eq!(config.poster(), Some("data-src=\"&&\""));
        assert_eq!(config.sniff_words(), Some(".m3u8#.mp4"));
        assert_eq!(config.play_headers(), Some("User-Agent$UA/1.0"));
        // This fixture has no Jsoup-only keys, so it is the marker dialect.
        assert!(!config.uses_jsoup_selectors());
    }

    #[test]
    fn identifies_the_jsoup_selector_dialect() {
        // A real configuration in the sibling dialect. Both dialects join with `&&`, so reading
        // these rules as text markers would produce silent nonsense — the adapter must recognise
        // the dialect and decline instead.
        let jsoup: XbpqConfig = serde_json::from_str(
            r#"{
              "分类链接": "https://www.tuxiaobei.com/list?typeId={cateId}&page={catePg}",
              "分类名称": "儿歌&故事",
              "分类名称替换词": "2&3",
              "分类列表数组规则": "data.items",
              "分类片单标题": "name",
              "分类片单链接": "video_id",
              "分类片单是否Jsoup写法": "0"
            }"#,
        )
        .unwrap();

        assert!(jsoup.uses_jsoup_selectors());

        // The marker dialect used by the majority of real configs must not be flagged.
        let marker: XbpqConfig = serde_json::from_str(REAL_CONFIG).unwrap();
        assert!(!marker.uses_jsoup_selectors());
    }

    #[test]
    fn falls_back_to_positional_ids_when_values_are_missing() {
        let config: XbpqConfig = serde_json::from_str(r#"{"分类":"电影&剧集"}"#).unwrap();
        let categories = categories(&config);

        assert_eq!(categories[0].id, "1");
        assert_eq!(categories[1].id, "2");
    }

    #[test]
    fn parses_play_headers_from_the_dollar_pair_form() {
        let config = real_config();
        let headers = play_headers(config.play_headers.as_deref());

        assert_eq!(headers.len(), 1);
        assert!(headers["User-Agent"].contains("Chrome/118"));
    }

    #[test]
    fn extracts_a_listing_record_through_the_real_markers() {
        let config: XbpqConfig = serde_json::from_str(
            r#"{
              "数组": "class=\"vod-item\"&&</li>",
              "标题": "title=\"&&\"",
              "图片": "data-src=\"&&\""
            }"#,
        )
        .unwrap();
        let base = "https://www.freeok.vip/vod-show/1-----------.html"
            .parse()
            .unwrap();
        let source = crate::SourceRecord {
            key: "fok".to_string(),
            name: "夸克影视".to_string(),
            source_type: "cms".to_string(),
            script_archive_id: None,
            source_dialect: None,
            site_type: Some(3),
            site_protocol: Some("spider".to_string()),
            api: "csp_XBPQ".to_string(),
            logo: None,
            description: None,
            nsfw: false,
            status: true,
            ext: Some(REAL_CONFIG.to_string()),
            extra: None,
            jar: None,
            epg: None,
            searchable: true,
            filterable: false,
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
        };
        let segment = r#"<li class="vod-item"><a href="/voddetail/123.html" title="一部影片"><img data-src="https://img.example/a.jpg"></a></li>"#;

        let item = parse_list_item(segment, &base, &source, &config, 0).unwrap();

        assert_eq!(item.name, "一部影片");
        assert_eq!(item.id, "https://www.freeok.vip/voddetail/123.html");
        assert_eq!(item.poster, "https://img.example/a.jpg");
    }

    #[test]
    fn reads_a_marker_slice_from_html_the_real_config_bounds() {
        // The `简介` marker from the real config, applied to the kind of HTML it targets.
        let marker = Marker::parse("<p>&&</p>").unwrap();
        let html = r#"<div class="detail"><p>科尔·里德是富豪的贴身保镖。</p></div>"#;

        assert_eq!(
            marker.first(html),
            Some("科尔·里德是富豪的贴身保镖。".to_string())
        );
    }

    #[test]
    fn parses_the_panda_key_value_serialization_into_the_same_struct() {
        // Real csp_Panda payload: the same vocabulary in `key:value,key:value` form.
        let raw = "分类url:http://web.zzdj.cc/index.php/vod/show/by/{by}/id/{cateId}/page/{catePg}.html,分类:快手$2#抖音$3#都市$4,分类值:2#3#4";

        assert!(super::looks_like_pair_config(raw));
        let value = super::pair_config_to_value(raw).unwrap();
        let config: XbpqConfig = serde_json::from_value(value).unwrap();

        assert_eq!(
            config.category_url.as_deref(),
            Some("http://web.zzdj.cc/index.php/vod/show/by/{by}/id/{cateId}/page/{catePg}.html")
        );
        assert_eq!(config.category_names.as_deref(), Some("快手$2#抖音$3#都市$4"));
    }

    #[test]
    fn a_url_is_not_mistaken_for_a_pair_config() {
        // The narrow check exists so that the common case (ext is a URL) is never misread.
        assert!(!super::looks_like_pair_config(
            "http://rihou.vip:88/hccx/七新影视.json"
        ));
        assert!(!super::looks_like_pair_config("./libs/xyq/港口.json"));
        assert!(!super::looks_like_pair_config("https://example.com/a.json"));
    }

    #[test]
    fn reads_records_when_no_separator_is_configured() {
        // The real freeok config omits `数组`, so the fallback path is the one that actually
        // runs for it. Records must be recovered from the detail links.
        let config: XbpqConfig = serde_json::from_str(
            r#"{"分类url":"https://example.com/list/{catePg}.html","标题":"title=\"&&\"","图片":"data-src=\"&&\""}"#,
        )
        .unwrap();
        let base = "https://example.com/list/1.html".parse().unwrap();
        let source = crate::SourceRecord {
            key: "fok".to_string(),
            name: "夸克影视".to_string(),
            source_type: "cms".to_string(),
            script_archive_id: None,
            source_dialect: None,
            site_type: Some(3),
            site_protocol: Some("xbpq".to_string()),
            api: "csp_XBPQ".to_string(),
            logo: None,
            description: None,
            nsfw: false,
            status: true,
            ext: Some(REAL_CONFIG.to_string()),
            extra: None,
            jar: None,
            epg: None,
            searchable: true,
            filterable: false,
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
        };
        // Two cards plus a nav link that must not become a record.
        let html = r#"
            <nav><a href="/">首页</a><a href="/list/2.html">下一页</a></nav>
            <div class="card"><a href="/voddetail/1.html" title="影片一"><img data-src="https://img.example/1.jpg"></a></div>
            <div class="card"><a href="/voddetail/2.html" title="影片二"><img data-src="https://img.example/2.jpg"></a></div>
        "#;

        let items = super::parse_items_without_separator(html, &base, &source, &config);

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "影片一");
        assert_eq!(items[0].id, "https://example.com/voddetail/1.html");
        assert_eq!(items[0].poster, "https://img.example/1.jpg");
        assert_eq!(items[1].name, "影片二");
    }

    #[test]
    fn finds_embedded_streams_through_the_sniff_words() {
        // The declarative reading of `嗅探词`: locate media URLs by the fragments the config
        // names, without loading the player page or executing anything.
        let config = real_config();
        let tokens = super::sniff_tokens(&config);
        let base = "https://www.freeok.vip/vodplay/1-1-1.html".parse().unwrap();
        let html = r#"
            <script>var player = {"url":"https:\/\/cdn.example\/hls\/abc\/index.m3u8","poster":"x.jpg"};</script>
            <a href="/vodplay/1-1-2.html">第 2 集</a>
        "#;

        let streams = super::sniff_media_urls(html, &base, &tokens);

        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0], "https://cdn.example/hls/abc/index.m3u8");
    }

    #[test]
    fn builds_play_lines_from_a_detail_page() {
        // End of the chain: a detail page with the real `线路数组` marker must produce playable
        // lines, and a line with a sniffed stream must point at the stream rather than the page.
        let config = real_config();
        let base = "https://www.freeok.vip/voddetail/1.html".parse().unwrap();
        let source = crate::SourceRecord {
            key: "fok".to_string(),
            name: "夸克影视".to_string(),
            source_type: "cms".to_string(),
            script_archive_id: None,
            source_dialect: None,
            site_type: Some(3),
            site_protocol: Some("xbpq".to_string()),
            api: "csp_XBPQ".to_string(),
            logo: None,
            description: None,
            nsfw: false,
            status: true,
            ext: Some(REAL_CONFIG.to_string()),
            extra: None,
            jar: None,
            epg: None,
            searchable: true,
            filterable: false,
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
        };
        // The real `线路数组` marker is `data-dropdown-value=&&</div>`, and `线路标题` is
        // `<span>&&</small>`, so the fixture uses exactly that shape.
        let html = r#"
            <div class="play" data-dropdown-value="秒播"><span>秒播</small>
              <a href="https://cdn.example/hls/a/index.m3u8">第 1 集</a>
              <a href="https://cdn.example/hls/b/index.m3u8">第 2 集</a>
            </div>
        "#;

        let lines = super::parse_play_lines(html, &base, &source, &config, "1");

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].name, "秒播");
        assert_eq!(lines[0].episodes.len(), 2);
        assert!(lines[0].episodes[0].url.ends_with("index.m3u8"));
    }

    #[test]
    fn prefers_a_sniffed_stream_over_a_play_page_link() {
        // The page link is not playable on its own; the sniffed stream is. The line must take
        // the stream.
        let config = real_config();
        let base = "https://www.freeok.vip/voddetail/1.html".parse().unwrap();
        let source = crate::SourceRecord {
            key: "fok".to_string(),
            name: "夸克影视".to_string(),
            source_type: "cms".to_string(),
            script_archive_id: None,
            source_dialect: None,
            site_type: Some(3),
            site_protocol: Some("xbpq".to_string()),
            api: "csp_XBPQ".to_string(),
            logo: None,
            description: None,
            nsfw: false,
            status: true,
            ext: Some(REAL_CONFIG.to_string()),
            extra: None,
            jar: None,
            epg: None,
            searchable: true,
            filterable: false,
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
        };
        // A play-page link and, separately, an embedded stream.
        let html = r#"
            <div class="play" data-dropdown-value="秒播"><span>秒播</small>
              <a href="/vodplay/1-1-1.html">第 1 集</a>
            </div>
            <script>var u = "https://cdn.example/hls/z/index.m3u8";</script>
        "#;

        let lines = super::parse_play_lines(html, &base, &source, &config, "1");

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].episodes.len(), 1);
        assert_eq!(
            lines[0].episodes[0].url,
            "https://cdn.example/hls/z/index.m3u8"
        );
    }
}
