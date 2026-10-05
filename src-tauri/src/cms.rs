use std::time::Instant;

use quick_xml::{events::Event, Reader};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    adapters::SiteAdapterKind,
    html,
    policy::{fetch_json, fetch_text, validate_remote_url},
    test_runs::TestRunRegistry,
    xbpq, SourceOperationResult, SourceRecord,
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
    if adapter == SiteAdapterKind::Xbpq {
        return xbpq::browse_source(source, query, category_id, current_page, current_page_size)
            .await;
    }
    // **One request, and it is the only request the library makes.**
    //
    // The alternative was measured and rejected. A deployment that hides its covers behind
    // `ac=detail` can be served by asking for that shape instead — on the `采集集合` extension the
    // listing is 5 KiB in 1.5–4.3 s while the detail shape is **406 KiB in 12.8–28.3 s** — and by
    // fetching it per work afterwards (20 requests, 6 762 ms, against 26 207 ms for one page-wide
    // request, for the same bytes). Both were turned down: the first made the library wait for the
    // sum of the two, and the second means a page of 20 cards becomes 20 requests against a single
    // host, which invites rate limiting and makes a library view nondeterministic. **A source that
    // publishes no covers with its listing is left showing none** — that is a legitimate answer, not
    // a defect to route around. A work's own page still fetches its detail record when it is opened.
    //
    // Only plain JSON CMS sources get the detail-shaped listing here. XML list responses already
    // carry `<pic>`, and HTTP-extension sources declare their own parameter conventions, so neither
    // is switched over.
    let wants_detail = listing_ac(adapter) == "detail";
    let params = catalog_params(
        adapter,
        listing_ac(adapter),
        query.clone(),
        category_id.clone(),
        current_page,
        current_page_size,
        source.ext.clone(),
    );
    let mut page = match fetch_catalog(&source, adapter, &params).await {
        Ok(payload) => {
            let parsed =
                parse_catalog_page(&payload, &source.key, current_page, current_page_size);
            if parsed.items.is_empty() && wants_detail {
                None
            } else {
                Some(parsed)
            }
        }
        // A few MacCMS deployments reject `ac=detail` without `ids`. Falling through to the
        // slim `ac=list` keeps browsing working there, losing only the covers — strictly
        // better than an empty library.
        Err(error) if !wants_detail => return Err(error),
        Err(_) => None,
    };
    if page.is_none() {
        let slim = catalog_params(
            adapter,
            "list",
            query,
            category_id,
            current_page,
            current_page_size,
            source.ext.clone(),
        );
        let payload = fetch_catalog(&source, adapter, &slim).await?;
        page = Some(parse_catalog_page(
            &payload,
            &source.key,
            current_page,
            current_page_size,
        ));
    }
    Ok(page.expect("a catalog page was produced above"))
}

/// The query parameters for the one-work detail request.
///
/// The list is built here rather than at the call site because an extension source's declared
/// parameters have to survive on this request too. They are the source's own conventions (`ext`
/// carries things like `{"params":{"token":…}}`), and dropping them asks the deployment a question
/// it will not answer — measured earlier on the real `采集集合` source, whose listing is slim and
/// whose covers only exist behind `ac=detail`. `catalog_params` already applies them for a listing;
/// this reuses the same helper so the two requests cannot drift apart.
fn detail_params(
    adapter: SiteAdapterKind,
    vod_id: &str,
    ext: Option<String>,
) -> Vec<(String, String)> {
    let mut params = vec![
        ("ac".to_string(), "detail".to_string()),
        ("ids".to_string(), vod_id.to_string()),
    ];
    if adapter == SiteAdapterKind::HttpExtension {
        append_declared_extension_params(&mut params, ext.as_deref());
    }
    params
}

/// The query parameters for one catalog request, for whichever adapter this source uses.
///
/// The `ac` is a parameter of this function rather than something each caller assembles, because
/// the cover enrichment has to re-ask the *same* adapter with a different `ac`. Building that
/// request with the plain CMS helper instead would silently drop an extension source's own
/// declared parameters, which is why the enrichment used to be disabled for that adapter.
fn catalog_params(
    adapter: SiteAdapterKind,
    ac: &str,
    query: String,
    category_id: Option<String>,
    page: u32,
    page_size: u32,
    ext: Option<String>,
) -> Vec<(String, String)> {
    match adapter {
        SiteAdapterKind::HttpExtension => {
            extension_params(ac, query, category_id, page, page_size, ext)
        }
        _ => cms_params_with_ac(ac, query, category_id, page, page_size),
    }
}

/// Issues the catalog request for one parameter set, on the document client.
///
/// There is no cover retry behind this any more. `should_retry_for_covers` — and later a display-layer
/// enrichment that asked per work — both existed to overrule a listing that carries no covers, and
/// both were removed by the user's decision that a source publishing no covers with its listing is
/// left alone. So this is exactly one request, and the caller renders what it answered.
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
        SiteAdapterKind::Xbpq => unreachable!("XBPQ 适配器已在载荷请求前返回"),
        SiteAdapterKind::Spider | SiteAdapterKind::Unsupported => {
            Err("该源没有可执行的安全站点适配器。".to_string())
        }
    }
}

/// A whole source test must finish within this budget, however many requests it makes.
///
/// The per-request timeout does not bound the test: a source is probed with a catalog request,
/// then a detail request, and each redirect is a fresh request. A host that accepts connections
/// and then stalls can therefore hold a test open for a multiple of the request timeout, and the
/// UI shows "测速中" for that whole time. This is the outer bound that makes the operation
/// terminable no matter what the remote does.
const SOURCE_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// Tests one source, cancellably.
///
/// `run_id` is optional so the single-row test button and any older caller keep working; a test
/// without one simply cannot be cancelled, which is exactly the previous behaviour.
///
/// **The cancellation is a `select!`, and the point is that the losing branch is DROPPED.** A flag
/// alone cannot interrupt an `await`; dropping the future is what closes the socket. Racing the
/// timeout against it means a cancel returns immediately instead of waiting out the 25 s bound —
/// which is what the user asked for when they reported that cancelling "还在后台测".
#[tauri::command]
pub async fn test_source(
    source: SourceRecord,
    run_id: Option<String>,
    registry: tauri::State<'_, TestRunRegistry>,
) -> Result<SourceTestResult, String> {
    let source_key = source.key.clone();
    let tested_at = "刚刚".to_string();
    let started = Instant::now();
    let adapter_id = SiteAdapterKind::from_source(&source).id().to_string();
    let timed = tokio::time::timeout(SOURCE_TEST_TIMEOUT, test_source_inner(source));
    let outcome = match run_id {
        Some(run_id) => {
            let flag = registry.flag_for(&run_id);
            tokio::select! {
                biased;
                _ = crate::test_runs::wait_for_cancellation(flag) => return Err(CANCELLED.into()),
                result = timed => result,
            }
        }
        None => timed.await,
    };
    match outcome {
        Ok(result) => result,
        Err(_) => Ok(SourceTestResult {
            source_key,
            status: "failed".to_string(),
            adapter_id,
            message: format!(
                "测试超时（{} 秒），已停止等待。该源可能无法访问或响应过慢。",
                SOURCE_TEST_TIMEOUT.as_secs()
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

/// The marker a cancelled test returns, so the frontend can tell it apart from a real failure.
///
/// A cancelled test must not be persisted as a result: the source would be marked 测试失败 or
/// switched off by a run the user explicitly abandoned. The frontend checks for this exact string,
/// which is why it is a constant rather than a literal repeated at each site.
pub const CANCELLED: &str = "__moseek_cancelled__";

async fn test_source_inner(source: SourceRecord) -> Result<SourceTestResult, String> {
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

            // The first item's full record, kept rather than discarded: the playback probe below
            // needs play addresses, and the slim listing this source test lists with may not carry
            // any. Before the listing and the detail shape were split, the probe silently depended
            // on the cover retry having succeeded, so a slow host could turn "playback" into
            // "empty" for a source that plays perfectly well.
            let probed_detail: Option<VodItem> = if let Some(item) = catalog.items.first() {
                let detail_started = Instant::now();
                let outcome = get_detail(source.clone(), item.id.clone()).await;
                let operation = match &outcome {
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
                        message: error.clone(),
                        duration_ms: detail_started.elapsed().as_millis() as u64,
                    },
                };
                operations.push(operation);
                outcome.ok().flatten()
            } else {
                operations.push(SourceOperationResult {
                    operation: "detail".to_string(),
                    status: "skipped".to_string(),
                    message: "没有可用于详情探测的影视条目。".to_string(),
                    duration_ms: 0,
                });
                None
            };

            // The detail record's lines come first: a slim listing legitimately carries none (the
            // real `采集集合` extension is one — every row has `vod_play_from` and no
            // `vod_play_url`), and the listing's own lines are only a fallback for sources whose
            // listing does carry them.
            let playback_operation = probed_detail
                .iter()
                .flat_map(|item| item.play_lines.iter())
                .flat_map(|line| line.episodes.iter())
                .chain(
                    catalog
                        .items
                        .iter()
                        .flat_map(|item| item.play_lines.iter())
                        .flat_map(|line| line.episodes.iter()),
                )
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

/// One work's full record, asked for by id.
///
/// This is the request a work's own page makes when it is opened — the play addresses live here, not
/// in the listing — and it is deliberately *not* made by the library. Filling a page of cards in with
/// covers this way was measured on the real `采集集合` source (**20 requests in 6 762 ms against one
/// page-wide request at 26 207 ms**, for the same bytes, with the first cover at 1.09 s) and then
/// rejected: a single host receiving one request per card invites rate limiting, and a library that
/// shifts under the user is worse than a library without covers. See [`browse_source`].
///
/// The parameters come from [`detail_params`], which keeps an extension source's declared parameters
/// — without them this asks a question the deployment will not answer, and the symptom would be a
/// work page that never loads its episodes.
#[tauri::command]
pub async fn get_detail(source: SourceRecord, vod_id: String) -> Result<Option<VodItem>, String> {
    let adapter = SiteAdapterKind::from_source(&source).ensure_executable(&source)?;
    if adapter == SiteAdapterKind::Html {
        return html::get_detail(source, vod_id).await;
    }
    if adapter == SiteAdapterKind::Xbpq {
        return xbpq::get_detail(source, vod_id).await;
    }
    let params = detail_params(adapter, &vod_id, source.ext.clone());
    let payload = match adapter {
        SiteAdapterKind::Html => unreachable!("HTML 适配器已在详情请求前返回"),
        SiteAdapterKind::Xbpq => unreachable!("XBPQ 适配器已在详情请求前返回"),
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

/// The request URL for one parameter set, built in one place so every CMS request — listing, cover
/// enrichment, detail probe — appends its parameters the same way.
fn catalog_url(api: &str, params: &[(String, String)]) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(api).map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in params {
            query.append_pair(key, value);
        }
    }
    Ok(url)
}

/// The byte cap for one CMS response. The detail shape of a real deployment measured 406 KiB for a
/// single page of 20 items, so this is generous rather than tight.
const CMS_RESPONSE_MAX_BYTES: usize = 15 * 1024 * 1024;

async fn request_json(api: &str, params: &[(String, String)]) -> Result<Value, String> {
    fetch_json(catalog_url(api, params)?, CMS_RESPONSE_MAX_BYTES, "CMS 响应").await
}

async fn request_text(api: &str, params: &[(String, String)]) -> Result<String, String> {
    fetch_text(catalog_url(api, params)?, CMS_RESPONSE_MAX_BYTES, "CMS 响应").await
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
    ac: &str,
    query: String,
    category_id: Option<String>,
    page: u32,
    page_size: u32,
    ext: Option<String>,
) -> Vec<(String, String)> {
    // Extension sources declare their own parameters via `ext`, so the default stays on the
    // historical `list` shape rather than inheriting the JSON CMS switch to `ac=detail`. The
    // caller may still ask for `detail` — that is the cover enrichment, which needs the same
    // adapter and the same declared overrides, only a different `ac`.
    let mut params = cms_params_with_ac(ac, query, category_id, page, page_size);
    append_declared_extension_params(&mut params, ext.as_deref());
    params
}

/// Appends what an extension source declared for its requests, as far as it is expressible.
///
/// Only the three known containers of scalar parameters are read (`params`, `query`, `httpParams`),
/// and only scalars inside them: an extension declaration is not a general-purpose query language,
/// and silently stringifying a nested object would send the deployment something it never asked
/// for. Shared by the listing request and the per-work detail request so the two cannot drift — a
/// declared token that survives browsing but not the detail lookup would show up as "the library
/// lists works, but every cover request fails".
fn append_declared_extension_params(params: &mut Vec<(String, String)>, ext: Option<&str>) {
    let Some(ext) = ext.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(ext) else {
        return;
    };
    for field in ["params", "query", "httpParams"] {
        if let Some(Value::Object(values)) = object.get(field) {
            append_scalar_params(params, values);
        }
    }
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
        // A folder is the source's own marker that a row is a container to navigate into rather
        // than a work. Measured on the real 采集集合 extension: its first category id returned 56
        // rows named "TV-无水印资源", "TV-电影天堂资源", … each carrying `vod_tag: "folder"` with no
        // cover and no play address, and all 56 were rendered as works in the library.
        .filter(|value| !is_folder_item(value))
        .map(|value| parse_item(value, source_key))
        .collect::<Vec<_>>();
    // The payload's own count includes the folders that were just dropped, so a page that held
    // nothing else must not still claim to hold works — that is what put "56 部" above a grid of
    // things that are not works. Only a wholly-folder page is re-counted; a mixed page keeps the
    // source's total, which is its claim about the whole result set rather than about this page.
    let folders_only = items.is_empty() && !list.is_empty();
    let total = if folders_only {
        0
    } else {
        value_u64(payload, &["total", "recordcount"]).unwrap_or(items.len() as u64)
    };
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

/// Whether a catalog row is a container rather than a work.
///
/// `vod_tag` is where MacCMS-style aggregates put `folder` for an entry that only exists to be
/// navigated into — a member site, a collection, a category. Such a row has no cover and no play
/// address, so rendering it as a work produces exactly the symptom this guards against: a library
/// of coverless cards whose names are the source's own sub-sites.
fn is_folder_item(value: &Value) -> bool {
    value
        .get("vod_tag")
        .and_then(Value::as_str)
        .is_some_and(|tag| tag.trim().eq_ignore_ascii_case("folder"))
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
        catalog_params, cms_params_with_ac, detail_params, extension_params, listing_ac,
        parse_catalog_page, parse_xml_payload,
    };
    use crate::adapters::SiteAdapterKind;
    use std::time::Instant;

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
            "list",
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

    /// XML and extension sources start on `ac=list`: XML normally returns `<pic>`, and
    /// extension sources declare their own parameters. A listing that turns out to be coverless is
    /// enriched afterwards, one work at a time, through `get_detail`.
    #[test]
    fn xml_and_extension_sources_keep_the_slim_listing() {
        assert_eq!(listing_ac(SiteAdapterKind::XmlHttp), "list");
        assert_eq!(listing_ac(SiteAdapterKind::HttpExtension), "list");
        assert_eq!(listing_ac(SiteAdapterKind::Html), "list");
        assert_eq!(listing_ac(SiteAdapterKind::Unsupported), "list");
    }

    /// The per-work detail request must still carry an extension source's declared parameters.
    ///
    /// This is the same rule the listing request follows, and it is now the *only* request the cover
    /// enrichment makes: a declared token that survives browsing but is dropped here would show up as
    /// "the library lists works, but no cover ever loads".
    #[test]
    fn the_detail_request_keeps_declared_extension_parameters() {
        let ext = Some(r#"{"params":{"token":"demo"},"query":{"lang":"zh"}}"#.to_string());

        let extension = detail_params(SiteAdapterKind::HttpExtension, "12343", ext.clone());
        assert!(extension.contains(&("ac".to_string(), "detail".to_string())));
        assert!(extension.contains(&("ids".to_string(), "12343".to_string())));
        assert!(extension.contains(&("token".to_string(), "demo".to_string())));
        assert!(extension.contains(&("lang".to_string(), "zh".to_string())));

        // A scalar `ext` (the real 采集集合 source carries `"0"`) declares nothing and must not
        // invent anything either.
        let scalar = detail_params(SiteAdapterKind::HttpExtension, "1", Some("0".to_string()));
        assert_eq!(scalar.len(), 2);

        // Plain CMS adapters have no declared parameters to apply.
        let cms = detail_params(SiteAdapterKind::JsonHttp, "1", ext);
        assert_eq!(cms.len(), 2);
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

    /// Extension sources list with `list`, but the enrichment may ask for `detail`.
    ///
    /// The default is `list` because an extension source declares its own conventions. That is not
    /// the same as declaring an `ac`, though: the real `采集集合` source carries the scalar ext `"0"`
    /// and says nothing about `ac`, so the default is all it gets — and its `list` listing has no
    /// covers and no play addresses. The enrichment therefore has to be able to ask for `detail`.
    #[test]
    fn extension_params_default_to_list_but_can_be_asked_for_detail() {
        let listing = extension_params("list", String::new(), None, 1, 20, None);
        assert!(listing.contains(&("ac".to_string(), "list".to_string())));

        let detail = extension_params("detail", String::new(), None, 1, 20, None);
        assert!(detail.contains(&("ac".to_string(), "detail".to_string())));
    }

    /// The enrichment must keep an extension source's declared parameters.
    ///
    /// Building that request with the plain CMS helper would drop them, which is the reason the
    /// enrichment was originally disabled for this adapter — the fix is to route both requests
    /// The listing request and the detail shape must both carry the declared parameters.
    ///
    /// Building either request with the plain CMS helper would drop them, which is the reason the
    /// enrichment was originally disabled for this adapter — the fix is to route both through
    /// `catalog_params`/`detail_params`, not to keep skipping the adapter.
    #[test]
    fn catalog_params_keep_extension_parameters_for_every_shape() {
        let ext = Some(r#"{"params":{"token":"demo"}}"#.to_string());
        let listing = catalog_params(
            SiteAdapterKind::HttpExtension,
            "list",
            String::new(),
            None,
            1,
            20,
            ext.clone(),
        );
        let detail = catalog_params(
            SiteAdapterKind::HttpExtension,
            "detail",
            String::new(),
            None,
            1,
            20,
            ext,
        );

        assert!(listing.contains(&("ac".to_string(), "list".to_string())));
        assert!(detail.contains(&("ac".to_string(), "detail".to_string())));
        for params in [&listing, &detail] {
            assert!(
                params.contains(&("token".to_string(), "demo".to_string())),
                "the declared parameter must survive on both requests"
            );
        }
    }

    /// The real `采集集合` source: the library shows exactly what its listing said, covers and all.
    ///
    /// This deployment publishes no covers with its listing (0/20) while the per-work detail record
    /// has them (20/20), so the library shows its own "暂无海报" state for these works instead of
    /// going and fetching one detail record per card. That fan-out was measured — **6 762 ms for 20
    /// requests against 26 207 ms for one page-wide request, for the same bytes** — and then
    /// **rejected by the user**: twenty requests against a single host invites rate limiting, and a
    /// library view must not be nondeterministic. Both halves of the fact are recorded here so that
    /// the day the covers are wanted, the trade-off is already measured rather than rediscovered.
    ///
    /// Ignored by default because it needs the network.
    #[test]
    #[ignore = "requires network access"]
    fn the_real_extension_source_publishes_no_covers_with_its_listing() {
        let source = crate::SourceRecord {
            key: "采集集合".to_string(),
            name: "采集集合".to_string(),
            source_type: "cms".to_string(),
            source_dialect: None,
            site_type: Some(4),
            site_protocol: Some("http-extension".to_string()),
            api: "http://zhangqun1818.serv00.net/cj/cjjh.php".to_string(),
            logo: None,
            description: None,
            nsfw: false,
            status: true,
            ext: Some("0".to_string()),
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
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // The listing is the whole request the library makes: one call, fast, and — on this
            // deployment — without covers.
            let listed_at = Instant::now();
            let page = super::browse_source(source.clone(), String::new(), None, 1, 20)
                .await
                .expect("the extension source browses");
            println!(
                "listing: items={} categories={} with_poster={} ms={}",
                page.items.len(),
                page.categories.len(),
                page.items
                    .iter()
                    .filter(|item| !item.poster.trim().is_empty())
                    .count(),
                listed_at.elapsed().as_millis()
            );
            assert!(!page.items.is_empty(), "the listing must not be empty");
            assert!(
                !page.categories.is_empty(),
                "the category list only exists in the listing, so it must arrive with it"
            );
            assert!(
                page.items.iter().all(|item| item.poster.trim().is_empty()),
                "this deployment's listing carries no covers — which is the whole point below"
            );

            // The covers are not missing from the source, they are behind a *per-work* request. That
            // is the shape the library refuses to pay for, so this assertion is what keeps the fact
            // honest: if it ever stops being true, the reason to look at covers at all has changed.
            let first = page.items.first().expect("a first item");
            let detail = super::get_detail(source, first.id.clone())
                .await
                .expect("a work's detail must not error")
                .expect("a work must have a detail record");
            println!(
                "one work's detail: poster={} play_lines={}",
                !detail.poster.trim().is_empty(),
                detail.play_lines.len()
            );
            assert!(
                !detail.poster.trim().is_empty(),
                "the cover exists, but only behind the request the library does not make"
            );
        });
    }

    /// The real `采集集合` source: its category ids are NOT what its own `class` array claims.
    ///
    /// This is the user's screenshot. The source advertises `class` entries with `type_id` 1..32, but
    /// asking for `t=1` returns **56 rows named "TV-无水印资源", "TV-电影天堂资源", …** — the
    /// aggregate's own member sites, each carrying `vod_tag: "folder"`, no cover and no play address.
    /// They were rendered as works, which is why the library showed a grid of coverless cards whose
    /// names are sub-sites rather than films.
    ///
    /// The fix is to treat `vod_tag: folder` as what it says. Ignored by default (needs the network).
    #[test]
    #[ignore = "requires network access"]
    fn the_real_extension_folder_rows_are_not_works() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // The default view: real works, with covers and play addresses.
            let page = super::browse_source(diag_extension_source(), String::new(), None, 1, 20)
                .await
                .expect("the source browses");
            println!(
                "default: items={} total={} with_poster={}",
                page.items.len(),
                page.total,
                page.items.iter().filter(|i| !i.poster.trim().is_empty()).count()
            );
            assert!(!page.items.is_empty());
            assert!(
                page.items.iter().all(|item| !item.name.starts_with("TV-")),
                "a member site must never be rendered as a work"
            );

            // The category that returns the folder list: nothing must survive as a work.
            let folders =
                super::browse_source(diag_extension_source(), String::new(), Some("1".to_string()), 1, 20)
                    .await
                    .expect("the folder category answers");
            println!("category 1: items={} total={}", folders.items.len(), folders.total);
            assert!(
                folders.items.is_empty(),
                "the folder rows must be filtered out, got {}",
                folders.items.len()
            );
            assert_eq!(
                folders.total, 0,
                "a page of nothing but folders must not still claim a work count"
            );
        });
    }

    /// The real `哆啦(XBPQ)` listing ships a lazy-load placeholder in `src`, not the cover.
    ///
    /// Measured: `<img class="b-lazy" src=".../img/load.gif" data-url="<the real cover>">`. The page
    /// only swaps the attribute in with JavaScript, which a fetch never runs, so every one of its 146
    /// cards rendered without a poster. Ignored by default (needs the network).
    #[test]
    #[ignore = "requires network access"]
    fn the_real_xbpq_listing_now_carries_covers() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let page = super::browse_source(diag_xbpq_source(), String::new(), None, 1, 20)
                .await
                .expect("the source browses");
            let with_poster = page
                .items
                .iter()
                .filter(|item| !item.poster.trim().is_empty())
                .count();
            println!("items={} with_poster={}", page.items.len(), with_poster);
            for item in page.items.iter().take(3) {
                println!("   {} | {}", item.name, item.poster);
            }
            assert!(!page.items.is_empty());
            assert_eq!(
                with_poster,
                page.items.len(),
                "every card must carry a cover"
            );
            assert!(
                page.items
                    .iter()
                    .all(|item| !item.poster.contains("load.gif")),
                "the lazy-load placeholder must never be used as a cover"
            );
        });
    }

    fn diag_extension_source() -> crate::SourceRecord {
        crate::SourceRecord {
            key: "采集集合".to_string(),
            name: "采集集合".to_string(),
            source_type: "cms".to_string(),
            source_dialect: None,
            site_type: Some(4),
            site_protocol: Some("http-extension".to_string()),
            api: "http://zhangqun1818.serv00.net/cj/cjjh.php".to_string(),
            logo: None,
            description: None,
            nsfw: false,
            status: true,
            ext: Some("0".to_string()),
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

    fn diag_xbpq_source() -> crate::SourceRecord {
        let ext = r#"{"请求头":"User-Agent$MOBILE_UA","编码":"UTF-8","主页url":"https://dora.xiaoxinbk.com/","数组":"class=\"card-img-bili\"&&</a>","标题":"alt=\"&&\"","图片":"https://p3.itc.cn/images01/20210326/93827cff964b4497a04f315ca47d530e.jpeg","链接":"href=\"&&\"","播放数组":"class=\"card-body button-list\"&&</div>","播放列表":"<a&&a>","播放链接":"href=\"&&\"","播放标题":".:雷蒙影视:.+>&&</","分类url":"https://www.dora-video.cn/search/sy/?niandai={year}&cat={class}&tag={cateId}&gaojijiansuo=1&zhuangtai={by}","分类":"全部$0#动画$20","剧情":"x","排序":"全部$0#完结$2"}"#;
        crate::SourceRecord {
            key: "csp_XBPQ_哆啦".to_string(),
            name: "雷蒙影视 | 🍚哆啦(XBPQ)".to_string(),
            source_type: "cms".to_string(),
            source_dialect: None,
            site_type: Some(3),
            site_protocol: Some("xbpq".to_string()),
            api: "csp_XBPQ".to_string(),
            logo: None,
            description: None,
            nsfw: false,
            status: true,
            ext: Some(ext.to_string()),
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

    /// A `vod_tag: folder` row is a container, not a work, and must not reach the library.
    ///
    /// This is the user's screenshot: the 采集集合 source's first category returned 56 rows named
    /// "TV-无水印资源", "TV-电影天堂资源", … every one carrying `vod_tag: "folder"`, no cover and no
    /// play address. They were listed as works.
    #[test]
    fn folder_rows_are_not_works() {
        let page = parse_catalog_page(
            &json!({
                "total": 3,
                "list": [
                    { "vod_id": "0-0", "vod_name": "TV-无水印资源", "vod_tag": "folder" },
                    { "vod_id": "0-1", "vod_name": "TV-电影天堂资源", "vod_tag": "folder" },
                    { "vod_id": "0-2", "vod_name": "TV-量子资源", "vod_tag": "Folder" },
                ],
            }),
            "采集集合",
            1,
            20,
        );

        assert!(
            page.items.is_empty(),
            "folder rows must be filtered out, got {:?}",
            page.items.iter().map(|i| &i.name).collect::<Vec<_>>()
        );
        // The payload's count included them, so leaving it would put "56 部" above an empty grid.
        assert_eq!(page.total, 0);
    }

    /// A normal work must survive the folder filter untouched.
    ///
    /// The guard keys on `vod_tag` alone, so a source that does not use the field at all — which is
    /// almost all of them — must be unaffected, including one whose tag is some other value.
    #[test]
    fn ordinary_rows_are_unaffected_by_the_folder_filter() {
        let page = parse_catalog_page(
            &json!({
                "total": 3,
                "list": [
                    { "vod_id": "1", "vod_name": "甲", "vod_pic": "https://img/a.jpg", "vod_play_url": "第1集$https://a.m3u8" },
                    { "vod_id": "2", "vod_name": "乙", "vod_tag": "电影", "vod_play_url": "第1集$https://b.m3u8" },
                    { "vod_id": "3", "vod_name": "丙", "vod_tag": "", "vod_play_url": "第1集$https://c.m3u8" },
                ],
            }),
            "source",
            1,
            20,
        );

        assert_eq!(page.items.len(), 3);
        assert_eq!(page.total, 3, "a page with works keeps the source's own total");
    }

    /// A mixed page keeps the source's total: only a wholly-folder page is re-counted.
    #[test]
    fn a_mixed_page_keeps_the_sources_total() {
        let page = parse_catalog_page(
            &json!({
                "total": 40,
                "list": [
                    { "vod_id": "0-0", "vod_name": "TV-某资源", "vod_tag": "folder" },
                    { "vod_id": "1", "vod_name": "甲", "vod_play_url": "第1集$https://a.m3u8" },
                ],
            }),
            "source",
            1,
            20,
        );

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.total, 40);
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
