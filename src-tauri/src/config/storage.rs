use std::collections::{HashMap, HashSet};

use reqwest::Url;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::policy::validate_remote_url;
use crate::{cms, ConfigDocument, ConfigDuplicateMatch, SourceRecord};

pub(super) fn serialize_sources(sources: &[SourceRecord]) -> Result<String, String> {
    serde_json::to_string(sources).map_err(|error| format!("配置源快照序列化失败：{error}"))
}

pub(super) fn deserialize_sources(
    value: Option<String>,
) -> Result<Option<Vec<SourceRecord>>, String> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let mut sources: Vec<SourceRecord> = serde_json::from_str(&value)
        .map_err(|error| format!("配置源快照解析失败：{error}"))?;
    for source in &mut sources {
        source.api = unwrap_local_proxy_url(&source.api);
    }
    Ok(Some(sources))
}

/// Unwraps a TVBox local-proxy URL into the address it actually points at.
///
/// Published configurations commonly route every source through the TVBox client's own loopback
/// proxy, e.g. `http://127.0.0.1:9978/proxy?do=live&url=https://example.com/list.m3u`. That
/// address only resolves while the TVBox app is running on this machine, so fetching it directly
/// is wrong as well as refused by the address policy — and the refusal describes our rule rather
/// than the real problem. The `url` parameter holds the source's actual address.
///
/// Applied when a document is read, so configurations imported before this existed are corrected
/// without being re-imported. Only the loopback wrapper is unwrapped, and only when it carries a
/// usable http(s) target; anything else is left exactly as it was.
pub(crate) fn unwrap_local_proxy_url(value: &str) -> String {
    let trimmed = value.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return value.to_string();
    }
    let Ok(parsed) = reqwest::Url::parse(trimmed) else {
        return value.to_string();
    };
    let Some(host) = parsed.host_str() else {
        return value.to_string();
    };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let is_loopback =
        host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "0.0.0.0";
    if !is_loopback {
        return value.to_string();
    }
    let target = parsed
        .query_pairs()
        .find(|(key, _)| key == "url" || key == "target")
        .map(|(_, value)| value.into_owned());
    match target {
        Some(target)
            if target.starts_with("http://") || target.starts_with("https://") =>
        {
            target
        }
        _ => value.to_string(),
    }
}

fn ensure_unique_source_keys(sources: &mut [SourceRecord]) {
    let mut used_keys = HashSet::new();
    let mut next_suffix_by_base = HashMap::new();

    for source in sources {
        let original_key = source.key.clone();
        let mut suffix = next_suffix_by_base.get(&original_key).copied().unwrap_or(2);
        let mut unique_key = original_key.clone();

        while used_keys.contains(&unique_key) {
            unique_key = format!("{original_key}-{suffix}");
            suffix += 1;
        }

        next_suffix_by_base.insert(original_key, suffix);
        used_keys.insert(unique_key.clone());
        source.key = unique_key;
    }
}

fn normalize_normalized_source_keys(normalized_config: &str, sources: &[SourceRecord]) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(normalized_config) else {
        return normalized_config.to_string();
    };

    for (section, is_live) in [("sites", false), ("lives", true)] {
        let Some(items) = value.get_mut(section).and_then(Value::as_array_mut) else {
            continue;
        };
        let source_iter = sources
            .iter()
            .filter(|source| (source.source_type == "live") == is_live);
        for (item, source) in items.iter_mut().zip(source_iter) {
            if let Some(object) = item.as_object_mut() {
                object.insert("key".to_string(), Value::String(source.key.clone()));
            }
        }
    }

    serde_json::to_string_pretty(&value).unwrap_or_else(|_| normalized_config.to_string())
}

fn load_legacy_sources(
    connection: &Connection,
    document_id: i64,
) -> Result<Vec<SourceRecord>, String> {
    let mut statement = connection
        .prepare("SELECT source_key, name, source_type, api, ext, jar, epg, searchable, filterable, capability, capability_note, enabled, last_checked_at, request_count FROM sources WHERE document_id = ?1 ORDER BY rowid")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![document_id], |row| {
            Ok(SourceRecord {
                key: row.get(0)?,
                name: row.get(1)?,
                source_type: row.get(2)?,
                source_dialect: None,
                site_type: None,
                site_protocol: None,
                api: row.get(3)?,
                logo: None,
                description: None,
                nsfw: false,
                status: true,
                ext: row.get(4)?,
                extra: None,
                jar: row.get(5)?,
                epg: row.get(6)?,
                searchable: row.get::<_, i64>(7)? != 0,
                filterable: row.get::<_, i64>(8)? != 0,
                capability: row.get(9)?,
                capability_note: row.get(10)?,
                test_status: None,
                test_message: None,
                tested_at: None,
                test_item_count: None,
                test_category_count: None,
                test_duration_ms: None,
                test_operations: Vec::new(),
                enabled: row.get::<_, i64>(11)? != 0,
                last_checked_at: row.get(12)?,
                request_count: row.get(13)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(super) fn load_config_document(
    connection: &Connection,
    document_id: i64,
) -> Result<Option<ConfigDocument>, String> {
    let document = connection
        .query_row(
            "SELECT id, name, raw_config, normalized_config, sources_json, source_base_url, live_count, imported_at FROM config_documents WHERE id = ?1",
            params![document_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((
        id,
        name,
        raw_config,
        normalized_config,
        sources_json,
        source_base_url,
        live_count,
        imported_at,
    )) = document
    else {
        return Ok(None);
    };
    let mut sources = deserialize_sources(sources_json)?
        .map_or_else(|| load_legacy_sources(connection, id), Ok)?;
    ensure_unique_source_keys(&mut sources);
    let normalized_config = normalize_normalized_source_keys(&normalized_config, &sources);
    Ok(Some(ConfigDocument {
        id,
        name,
        raw_config,
        normalized_config,
        source_count: sources.len() as i64,
        sources,
        live_count,
        imported_at,
        source_base_url,
    }))
}

pub(super) fn load_latest_document(
    connection: &Connection,
) -> Result<Option<ConfigDocument>, String> {
    let document_id = connection
        .query_row(
            "SELECT id FROM config_documents ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    document_id
        .map(|id| load_config_document(connection, id))
        .transpose()
        .map(|document| document.flatten())
}

pub(super) fn active_config_id(connection: &Connection) -> Result<Option<i64>, String> {
    let value = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'active_config_document_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(value) = value else {
        return Ok(None);
    };
    let Ok(document_id) = value.parse::<i64>() else {
        return Ok(None);
    };
    let exists = connection
        .query_row(
            "SELECT 1 FROM config_documents WHERE id = ?1",
            params![document_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    Ok(exists.then_some(document_id))
}

pub(super) fn load_active_document(
    connection: &Connection,
) -> Result<Option<ConfigDocument>, String> {
    if let Some(document_id) = active_config_id(connection)? {
        if let Some(document) = load_config_document(connection, document_id)? {
            return Ok(Some(document));
        }
    }
    load_latest_document(connection)
}

pub(super) fn set_config_source_base_url(
    connection: &mut Connection,
    document_id: i64,
    source_base_url: &str,
) -> Result<ConfigDocument, String> {
    let base_url =
        Url::parse(source_base_url.trim()).map_err(|error| format!("配置基址无效：{error}"))?;
    validate_remote_url(&base_url)?;
    let document = load_config_document(connection, document_id)?
        .ok_or_else(|| "配置不存在或已被删除".to_string())?;
    let mut sources = document.sources.clone();
    for source in &mut sources {
        source.api = resolve_configured_url(&source.api, &base_url)?;
        if let Some(epg) = source.epg.as_deref() {
            source.epg = Some(resolve_configured_url(epg, &base_url)?);
        }
        if source.source_type == "live" && is_http_url(&source.api) {
            source.capability = "supported".to_string();
            source.capability_note =
                "支持通过 Rust 网络层解析 M3U、TXT 或 JSON 直播频道。".to_string();
            source.searchable = true;
            source.filterable = true;
            source.enabled = source.status;
            source.test_status = None;
            source.test_message = None;
            source.tested_at = None;
            source.test_item_count = None;
            source.test_category_count = None;
            source.test_duration_ms = None;
            source.test_operations = Vec::new();
        }
    }
    let sources_json = serialize_sources(&sources)?;
    let normalized_config = update_normalized_source_urls(&document.normalized_config, &sources);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE config_documents SET sources_json = ?1, normalized_config = ?2, source_base_url = ?3 WHERE id = ?4",
            params![sources_json, normalized_config, base_url.as_str(), document_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    load_config_document(connection, document_id)?
        .ok_or_else(|| "配置基址保存后无法读取配置".to_string())
}

pub(super) fn replace_known_live_source_urls(
    connection: &mut Connection,
    document_id: i64,
    replacements: &HashMap<String, String>,
) -> Result<Option<ConfigDocument>, String> {
    let document = load_config_document(connection, document_id)?
        .ok_or_else(|| "配置不存在或已被删除".to_string())?;
    let mut sources = document.sources.clone();
    let mut changed = false;
    for source in &mut sources {
        let Some(url) = replacements.get(&source.key) else {
            continue;
        };
        source.api = url.clone();
        if source.source_type == "live" {
            source.capability = "supported".to_string();
            source.capability_note =
                "已自动恢复为公开兼容直播列表；请通过连接测试确认当前频道可用性。".to_string();
            source.searchable = true;
            source.filterable = true;
            source.enabled = source.status;
            source.test_status = None;
            source.test_message = None;
            source.tested_at = None;
            source.test_item_count = None;
            source.test_category_count = None;
            source.test_duration_ms = None;
            source.test_operations = Vec::new();
        }
        changed = true;
    }
    if !changed {
        return Ok(None);
    }
    let sources_json = serialize_sources(&sources)?;
    let normalized_config = update_normalized_source_urls(&document.normalized_config, &sources);
    // `raw_config` has to move with the other two.
    //
    // It used to be left alone, so the document held three different spellings of one address: the
    // raw text kept the relative `./libs/tv/tvlive.txt`, `normalized_config` kept whatever the base
    // URL resolved that to, and only the list carried the recovered working URL. Measured on the
    // author's configuration, that is exactly what the three stores said.
    //
    // The consequence is that any later pass which re-derives the normalised form from the raw text
    // — an import, or a save from the raw tab — puts the old address back, silently undoing a repair
    // the app performed by itself. Rewriting all three keeps them agreeing.
    let raw_config = update_raw_source_urls(&document.raw_config, &sources);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE config_documents SET sources_json = ?1, normalized_config = ?2, raw_config = ?3, source_base_url = NULL WHERE id = ?4",
            params![sources_json, normalized_config, raw_config, document_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    load_config_document(connection, document_id).map_err(|error| error.to_string())
}

/// Rewrites the address of a live entry in the raw text to match the source it describes.
///
/// Matched by name, because that is the only field the raw text and the source list reliably agree
/// on: the raw text spells the key as the author wrote it (`-4`) while the list carries the parser's
/// own key (`live-2-2`), so a key match finds nothing. Name is also what the recovery command itself
/// keys on when it decides these are the same source.
///
/// Parses and re-serialises the whole document, so it returns the input unchanged when the text is
/// unreadable rather than replacing a configuration with an empty one.
fn update_raw_source_urls(raw_config: &str, sources: &[SourceRecord]) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw_config) else {
        return raw_config.to_string();
    };
    let Some(object) = value.as_object_mut() else {
        return raw_config.to_string();
    };
    let Some(items) = object.get_mut("lives").and_then(Value::as_array_mut) else {
        return raw_config.to_string();
    };

    let mut changed = false;
    for item in items.iter_mut() {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(source) = sources
            .iter()
            .find(|source| source.source_type == "live" && source.name == name)
        else {
            continue;
        };
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        if object.get("url").and_then(Value::as_str) == Some(source.api.as_str()) {
            continue;
        }
        if object.contains_key("url") {
            object.insert("url".to_string(), Value::String(source.api.clone()));
            changed = true;
        } else if object.contains_key("api") {
            object.insert("api".to_string(), Value::String(source.api.clone()));
            changed = true;
        }
    }

    if !changed {
        return raw_config.to_string();
    }
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| raw_config.to_string())
}

fn resolve_configured_url(value: &str, base_url: &Url) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || Url::parse(trimmed).is_ok() {
        return Ok(trimmed.to_string());
    }
    if !looks_like_relative_path(trimmed) {
        return Ok(trimmed.to_string());
    }
    let resolved = base_url
        .join(trimmed)
        .map_err(|error| format!("相对资源地址无法解析：{error}"))?;
    validate_remote_url(&resolved)?;
    Ok(resolved.to_string())
}

fn looks_like_relative_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
        || (value.contains('/') && !value.contains("://"))
}

fn is_http_url(value: &str) -> bool {
    Url::parse(value)
        .map(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn update_normalized_source_urls(normalized_config: &str, sources: &[SourceRecord]) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(normalized_config) else {
        return normalized_config.to_string();
    };
    for section in ["sites", "lives"] {
        let Some(items) = value.get_mut(section).and_then(Value::as_array_mut) else {
            continue;
        };
        for item in items {
            let Some(key) = item.get("key").and_then(Value::as_str) else {
                continue;
            };
            let Some(source) = sources.iter().find(|source| source.key == key) else {
                continue;
            };
            if let Some(object) = item.as_object_mut() {
                object.insert("api".to_string(), Value::String(source.api.clone()));
                if let Some(epg) = &source.epg {
                    object.insert("epg".to_string(), Value::String(epg.clone()));
                }
                object.insert(
                    "capability".to_string(),
                    Value::String(source.capability.clone()),
                );
                object.insert(
                    "capabilityNote".to_string(),
                    Value::String(source.capability_note.clone()),
                );
                object.insert("enabled".to_string(), Value::Bool(source.enabled));
                object.insert(
                    "testStatus".to_string(),
                    source
                        .test_status
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
            }
        }
    }
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| normalized_config.to_string())
}

fn update_normalized_source_enabled(
    normalized_config: &str,
    source_key: &str,
    enabled: bool,
) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(normalized_config) else {
        return normalized_config.to_string();
    };
    for section in ["sites", "lives"] {
        let Some(items) = value.get_mut(section).and_then(Value::as_array_mut) else {
            continue;
        };
        for item in items {
            if item.get("key").and_then(Value::as_str) != Some(source_key) {
                continue;
            }
            if let Some(object) = item.as_object_mut() {
                object.insert("enabled".to_string(), Value::Bool(enabled));
            }
        }
    }
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| normalized_config.to_string())
}

fn update_normalized_source_test(
    normalized_config: &str,
    source_key: &str,
    result: &cms::SourceTestResult,
    request_count: i64,
) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(normalized_config) else {
        return normalized_config.to_string();
    };
    for section in ["sites", "lives"] {
        let Some(items) = value.get_mut(section).and_then(Value::as_array_mut) else {
            continue;
        };
        for item in items {
            if item.get("key").and_then(Value::as_str) != Some(source_key) {
                continue;
            }
            if let Some(object) = item.as_object_mut() {
                object.insert(
                    "testStatus".to_string(),
                    Value::String(result.status.clone()),
                );
                object.insert(
                    "testMessage".to_string(),
                    Value::String(result.message.clone()),
                );
                object.insert(
                    "testedAt".to_string(),
                    Value::String(result.tested_at.clone()),
                );
                object.insert(
                    "testItemCount".to_string(),
                    Value::Number(result.item_count.into()),
                );
                object.insert(
                    "testCategoryCount".to_string(),
                    Value::Number(result.category_count.into()),
                );
                object.insert(
                    "testDurationMs".to_string(),
                    Value::Number(result.duration_ms.into()),
                );
                object.insert(
                    "testOperations".to_string(),
                    serde_json::to_value(&result.operations)
                        .unwrap_or_else(|_| Value::Array(Vec::new())),
                );
                object.insert(
                    "lastCheckedAt".to_string(),
                    Value::String(result.tested_at.clone()),
                );
                object.insert(
                    "requestCount".to_string(),
                    Value::Number(request_count.into()),
                );
                // Mirrors the snapshot: a source proved broken stops being offered, so the
                // stored configuration and the exported result agree with what the list shows.
                if result.status == "failed" || result.status == "empty" {
                    object.insert("enabled".to_string(), Value::Bool(false));
                }
            }
        }
    }
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| normalized_config.to_string())
}

/// Removes one source from a document, and the same entry from its raw configuration.
///
/// A user pruning their configuration wants the source gone, not merely hidden: it should stop
/// appearing in the library, stop being probed, and stop being exported. So the removal is
/// applied to both the normalized snapshot and the raw text the user imported — leaving the raw
/// text untouched would resurrect the source on the next import or export.
///
/// Which entry to drop is decided by the source's identity rather than its `key`, because the two
/// representations generate keys independently and the raw text is written by the author, who often
/// declares none at all. See `remove_sources_from_config`.
pub(super) fn remove_sources_in_connection(
    connection: &mut Connection,
    document_id: i64,
    source_keys: &[String],
) -> Result<ConfigDocument, String> {
    if source_keys.is_empty() {
        return Err("没有指定要删除的源".to_string());
    }
    let document = load_config_document(connection, document_id)?
        .ok_or_else(|| "配置不存在或已被删除".to_string())?;

    let removing: HashSet<&str> = source_keys.iter().map(String::as_str).collect();
    let sources: Vec<SourceRecord> = document
        .sources
        .iter()
        .filter(|source| !removing.contains(source.key.as_str()))
        .cloned()
        .collect();
    if sources.len() == document.sources.len() {
        return Err("配置中找不到要删除的源".to_string());
    }
    let removed: Vec<SourceRecord> = document
        .sources
        .iter()
        .filter(|source| removing.contains(source.key.as_str()))
        .cloned()
        .collect();

    // Both texts are matched against the identity the merge uses. The base URL is what makes a
    // relative address (`./libs/tv/tvlive.txt`) comparable to the one the import resolved, so it is
    // required for the match and is simply absent on a document imported without one.
    let base_url = document
        .source_base_url
        .as_deref()
        .and_then(|value| Url::parse(value.trim()).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"));

    let sources_json = serialize_sources(&sources)?;
    let normalized_config =
        remove_sources_from_config(&document.normalized_config, base_url.as_ref(), &removed, &sources);
    let raw_config =
        remove_sources_from_config(&document.raw_config, base_url.as_ref(), &removed, &sources);
    // `source_count` is derived from `sources_json` when the document is read, so only the live
    // tally is stored alongside it.
    let live_count = sources
        .iter()
        .filter(|source| source.source_type == "live")
        .count() as i64;

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE config_documents SET sources_json = ?1, normalized_config = ?2, raw_config = ?3, live_count = ?4 WHERE id = ?5",
            params![
                sources_json,
                normalized_config,
                raw_config,
                live_count,
                document_id
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    load_config_document(connection, document_id)?.ok_or_else(|| "配置更新后无法读取".to_string())
}

/// True when a value names its own scheme, i.e. is an absolute address rather than a relative path.
///
/// Mirrors the parser's `/^[a-z][a-z\d+.-]*:/i`. A dialect token is not one (`csp_Bili` has no
/// colon), while `https://…`, `./libs/x.js` is not, and `javascript:` is.
fn has_url_scheme(value: &str) -> bool {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for character in characters {
        if character == ':' {
            return true;
        }
        if character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-') {
            continue;
        }
        return false;
    }
    false
}

/// One canonical spelling of an address, so the raw text and the source list can be compared.
///
/// The two representations store the same address differently. The raw text holds it as the author
/// wrote it (`csp_Bili`, `./libs/tv/tvlive.txt`, sometimes still wrapped in the TVBox loopback
/// proxy); the source list holds whatever the import resolved it to, and a document imported before
/// a base URL was set keeps the unresolved spelling. Resolving both sides against the document base
/// and folding case and trailing slashes is what makes the same source compare equal on both sides.
fn canonical_address(value: &str, base_url: Option<&Url>) -> String {
    let unwrapped = unwrap_local_proxy_url(value);
    let trimmed = unwrapped.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let resolved = if has_url_scheme(trimmed) {
        trimmed.to_string()
    } else {
        match base_url.and_then(|base| base.join(trimmed).ok()) {
            Some(joined) => joined.to_string(),
            None => trimmed.to_string(),
        }
    };
    resolved.trim().trim_end_matches('/').to_lowercase()
}

/// A canonical spelling of a JSON value, so two equal values compare equal.
///
/// A configuration writes `ext` as an object while the source record stores it as a string, and the
/// same mapping must not look like two different ones just because of key order or whitespace.
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let inner = entries
                .iter()
                .map(|(key, item)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_json(item)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{inner}}}")
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => serde_json::to_string(other)
            .unwrap_or_default()
            .to_lowercase(),
    }
}

/// A canonical spelling of an `ext`, whether it arrives as text, a JSON object, or nothing.
fn canonical_ext(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            let looks_like_json = (trimmed.starts_with('{') && trimmed.ends_with('}'))
                || (trimmed.starts_with('[') && trimmed.ends_with(']'));
            if looks_like_json {
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(parsed) => canonical_json(&parsed),
                    Err(_) => trimmed.to_lowercase(),
                }
            } else {
                trimmed.to_lowercase()
            }
        }
        Some(other) => canonical_json(other),
    }
}

/// The identity of a source: which source this is, independent of the display key.
///
/// This is the same pair the merge uses to decide whether two configurations describe the same
/// source. Removal has to use it too: `key` is generated independently on each side — the parser
/// numbers an entry that declares no key (`live-1`) while the merge suffixes the blank key it sees
/// (`-2`) — so the two never agree, and a removal that matched on `key` left the raw entry behind.
fn source_identity(api: &str, ext: Option<&Value>, base_url: Option<&Url>) -> String {
    format!(
        "{}|{}",
        canonical_address(api, base_url),
        canonical_ext(ext)
    )
}

/// The identity of a stored source record.
fn record_identity(source: &SourceRecord, base_url: Option<&Url>) -> String {
    let ext = source.ext.as_ref().map(|text| Value::String(text.clone()));
    source_identity(&source.api, ext.as_ref(), base_url)
}

/// The address a raw entry carries: `url` for a live source, `api` for a site, falling back to the
/// spellings a configuration may use instead.
fn entry_address(item: &Value, is_live: bool) -> &str {
    let Some(map) = item.as_object() else {
        return "";
    };
    let fields: &[&str] = if is_live {
        &["url", "source", "api"]
    } else {
        &["api"]
    };
    fields
        .iter()
        .find_map(|field| map.get(*field).and_then(Value::as_str))
        .unwrap_or("")
}

/// The identity of an entry inside a configuration text.
fn entry_identity(item: &Value, is_live: bool, base_url: Option<&Url>) -> String {
    source_identity(
        entry_address(item, is_live),
        item.get("ext"),
        base_url,
    )
}

/// The display name of an entry, folded so casing and padding cannot make it look absent.
fn entry_label(item: &Value) -> String {
    item.get("name")
        .and_then(Value::as_str)
        .map(|name| name.trim().to_lowercase())
        .unwrap_or_default()
}

/// Drops the removed sources from the `sites` / `lives` arrays of a configuration text.
///
/// Entries are matched by identity — the same `api + ext` pair the merge dedupes on — and only then
/// by `key`, because the two representations generate keys independently and the raw text is
/// written by the author, who often declares no key at all. Matching on `key` alone silently missed
/// those entries, so a deleted source stayed in the raw configuration and came back on the next
/// import or export.
///
/// Several entries can legitimately share one identity (`xgapp` and `骑骑影院` are the same adapter
/// with the same `ext`), so a match is refined by `key`, then by name, and each raw entry is claimed
/// at most once — otherwise deleting one of a pair would remove both.
///
/// When the text holds more entries than the list, the surplus ones the list no longer has are
/// dropped as well. That is what clears a source deleted before this matching existed — the user's
/// own configuration held eleven such live entries — and it runs only when the list is shown to
/// describe this same text, so an unrelated text is never pruned.
///
/// Returns the input unchanged when it is not parseable, so an unparseable configuration is never
/// silently emptied by a removal.
fn remove_sources_from_config(
    config_text: &str,
    base_url: Option<&Url>,
    removed: &[SourceRecord],
    remaining: &[SourceRecord],
) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(config_text) else {
        return config_text.to_string();
    };
    let Some(object) = value.as_object_mut() else {
        return config_text.to_string();
    };

    for (section, is_live) in [("sites", false), ("lives", true)] {
        let Some(items) = object.get_mut(section).and_then(Value::as_array_mut) else {
            continue;
        };
        let wanted: Vec<&SourceRecord> = remaining
            .iter()
            .filter(|source| (source.source_type == "live") == is_live)
            .collect();
        let kept_identities: HashSet<String> = wanted
            .iter()
            .map(|source| record_identity(source, base_url))
            .collect();
        let kept_labels: HashSet<String> = wanted
            .iter()
            .map(|source| source.name.trim().to_lowercase())
            .collect();

        // **Each entry's identity is computed once, not once per (removed source, entry) pair.**
        //
        // This was previously computed inside the matching loop below, which made the whole removal
        // O(removed × entries) with a `Url::parse` and possibly a JSON parse in the innermost step.
        // Measured on the owner's 1701-source document removing 1347 sources, in release: **1.09 s for
        // the normalized text and 0.89 s for the raw one** — about two seconds of a frozen window for
        // one button press, which is what the user reported as the button "getting stuck". Hoisting
        // these turns the inner step into a hash lookup.
        let identities: Vec<String> = items
            .iter()
            .map(|item| entry_identity(item, is_live, base_url))
            .collect();
        let labels: Vec<String> = items.iter().map(entry_label).collect();
        let addressable: Vec<bool> = items
            .iter()
            .map(|item| !entry_address(item, is_live).trim().is_empty())
            .collect();
        // Identity to the entries carrying it, in document order — the order is what preserves
        // `min_by_key`'s "first of equal minima" behaviour, so the same entry is chosen as before.
        let mut by_identity: HashMap<&str, Vec<usize>> = HashMap::new();
        for (index, identity) in identities.iter().enumerate() {
            by_identity.entry(identity.as_str()).or_default().push(index);
        }
        // Owned keys rather than borrowed ones: `items` is borrowed mutably by `retain` below, and a
        // borrow of it held this long would not compile.
        let item_keys: Vec<Option<String>> = items
            .iter()
            .map(|item| item.get("key").and_then(Value::as_str).map(str::to_string))
            .collect();
        let mut by_key: HashMap<&str, Vec<usize>> = HashMap::new();
        for (index, key) in item_keys.iter().enumerate() {
            if let Some(key) = key {
                by_key.entry(key.as_str()).or_default().push(index);
            }
        }
        // Membership sets for the traceability check below, which had the same nested-scan shape.
        let present_identities: HashSet<&str> =
            identities.iter().map(String::as_str).collect();
        let present_labels: HashSet<&str> = labels.iter().map(String::as_str).collect();

        let mut drop = vec![false; items.len()];

        for source in removed
            .iter()
            .filter(|source| (source.source_type == "live") == is_live)
        {
            let identity = record_identity(source, base_url);
            let label = source.name.trim().to_lowercase();
            // Rank the candidates so an exact key wins, then a matching name, then order. Without
            // the ranking, two entries sharing an identity (`Aid` / `Aid-2`) would let a deletion
            // take whichever came first in the text.
            let best = by_identity
                .get(identity.as_str())
                .and_then(|candidates| {
                    candidates
                        .iter()
                        .copied()
                        // Only an addressable entry can be identified; one without an address would
                        // otherwise match a source whose address is equally empty.
                        .filter(|index| !drop[*index] && addressable[*index])
                        .min_by_key(|index| {
                            if item_keys[*index].as_deref() == Some(source.key.as_str()) {
                                0
                            } else if labels[*index] == label {
                                1
                            } else {
                                2
                            }
                        })
                })
                .or_else(|| {
                    // An entry that carries no usable address cannot be matched by identity, so the
                    // key is still tried — it is what the previous implementation relied on.
                    by_key
                        .get(source.key.as_str())
                        .and_then(|candidates| {
                            candidates.iter().copied().find(|index| !drop[*index])
                        })
                });
            if let Some(index) = best {
                drop[index] = true;
            }
        }

        // The list holds fewer sources than the text holds entries, so the text still describes
        // sources that were deleted. Pruning them is what clears a source removed before this
        // matching existed — otherwise it would stay in the user's configuration forever, which is
        // the very thing they reported.
        //
        // It is also the only part of a removal that can drop an entry nobody asked about, so before
        // it runs the two must be shown to describe the same document: most of the list's OWN
        // sources have to be traceable in this text, by identity or by name. When they are, the
        // entries left over are deletions; when they are not, the text and the list are unrelated
        // and nothing is pruned.
        //
        // The check uses the list as it stood BEFORE this removal (remaining plus removed), which is
        // the state that was in sync with the text — after a removal that took the last match the
        // remainder would explain nothing, and cleaning up is precisely what is wanted then.
        let known: Vec<&SourceRecord> = wanted
            .iter()
            .copied()
            .chain(
                removed
                    .iter()
                    .filter(|source| (source.source_type == "live") == is_live),
            )
            .collect();
        let traceable = known
            .iter()
            .filter(|source| {
                let identity = record_identity(source, base_url);
                let label = source.name.trim().to_lowercase();
                // Looked up in the sets built above rather than by rescanning every entry. The scan
                // was the same O(known × entries) shape as the matching loop, and it recomputed every
                // entry's identity on each pass.
                present_identities.contains(identity.as_str())
                    || (!label.is_empty() && present_labels.contains(label.as_str()))
            })
            .count();

        if items.len() > wanted.len() && traceable * 2 >= known.len() && traceable > 0 {
            for index in 0..items.len() {
                if drop[index] {
                    continue;
                }
                // An entry that names no address cannot be identified — a live entry may carry only
                // `channels`, for instance — so it is left exactly as it was rather than guessed at.
                if !addressable[index] {
                    continue;
                }
                if kept_identities.contains(identities[index].as_str()) {
                    continue;
                }
                let label = labels[index].as_str();
                if !label.is_empty() && kept_labels.contains(label) {
                    continue;
                }
                drop[index] = true;
            }
        }

        let mut position = 0usize;
        items.retain(|_| {
            let keep = !drop[position];
            position += 1;
            keep
        });
    }

    serde_json::to_string_pretty(&value).unwrap_or_else(|_| config_text.to_string())
}

pub(super) fn set_source_enabled_in_connection(
    connection: &mut Connection,
    document_id: i64,
    source_key: &str,
    enabled: bool,
) -> Result<ConfigDocument, String> {
    let document = load_config_document(connection, document_id)?
        .ok_or_else(|| "配置不存在或已被删除".to_string())?;
    let mut sources = document.sources.clone();
    let source = sources
        .iter_mut()
        .find(|source| source.key == source_key)
        .ok_or_else(|| "配置中找不到该资源源".to_string())?;
    source.enabled = enabled;
    let sources_json = serialize_sources(&sources)?;
    let normalized_config =
        update_normalized_source_enabled(&document.normalized_config, source_key, enabled);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE config_documents SET sources_json = ?1, normalized_config = ?2 WHERE id = ?3",
            params![sources_json, normalized_config, document_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    load_config_document(connection, document_id)?.ok_or_else(|| "配置更新后无法读取".to_string())
}

pub(super) fn set_source_test_in_connection(
    connection: &mut Connection,
    document_id: i64,
    source_key: &str,
    result: &cms::SourceTestResult,
) -> Result<ConfigDocument, String> {
    let document = load_config_document(connection, document_id)?
        .ok_or_else(|| "配置不存在或已被删除".to_string())?;
    let mut sources = document.sources.clone();
    let request_count = {
        let source = sources
            .iter_mut()
            .find(|source| source.key == source_key)
            .ok_or_else(|| "配置中找不到该资源源".to_string())?;
        source.test_status = Some(result.status.clone());
        source.test_message = Some(result.message.clone());
        source.tested_at = Some(result.tested_at.clone());
        source.test_item_count = Some(result.item_count);
        source.test_category_count = Some(result.category_count);
        source.test_duration_ms = Some(result.duration_ms);
        source.test_operations = result.operations.clone();
        source.last_checked_at = result.tested_at.clone();
        if result.status != "blocked" {
            source.request_count += 1;
        }
        // A source the test found to be broken is switched off, so it stops appearing in the
        // library and in live. Leaving it enabled would keep offering a source we have just
        // proved does not work. `passed` and `blocked` are left alone: the first works, and the
        // second was never enabled by a test in the first place.
        //
        // **Every failure switches the source off, including one that never reached the server.**
        // This used to exempt transport failures — a timeout, a name that did not resolve, a
        // refused connection — on the theory that they report the network rather than the source.
        // The user's decision is the opposite, and it is the simpler rule: a source we cannot
        // reach is a source we cannot use, so it is 测试失败 like any other and belongs in the same
        // 清理不可用 set. The cost of being wrong is bounded — the switch is one click away, and the
        // source can be re-enabled — whereas the old rule left unusable sources switched on and
        // therefore offered in the library, which is the thing the user actually saw and objected
        // to.
        if result.status == "failed" || result.status == "empty" {
            source.enabled = false;
        }
        // Deliberately no branch that switches a source back on. `enabled: false` with `status:
        // true` cannot be told apart from the user having switched the source off themselves, so
        // re-enabling on a pass would silently override an explicit choice.
        source.request_count
    };
    let sources_json = serialize_sources(&sources)?;
    let normalized_config = update_normalized_source_test(
        &document.normalized_config,
        source_key,
        result,
        request_count,
    );
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE config_documents SET sources_json = ?1, normalized_config = ?2 WHERE id = ?3",
            params![sources_json, normalized_config, document_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    load_config_document(connection, document_id)?
        .ok_or_else(|| "测试结果保存后无法读取配置".to_string())
}

/// Finds a stored document that the configuration about to be imported resembles, so the
/// caller can let the user decide between skipping the import and importing anyway.
///
/// Text equality alone is not enough. The interesting case is a configuration that was
/// imported once and then trimmed by hand: re-importing the untouched original produces
/// different text, so it looks brand new even though the user already has it. Comparing the
/// source key sets catches that, because a trimmed document's keys are a subset of the
/// original's. Matching is intentionally generous — the user is asked, not blocked — so a
/// false positive costs one click while a missed match silently duplicates a configuration.
pub(crate) fn find_config_duplicate(
    connection: &Connection,
    raw_config: &str,
    source_keys: &[String],
    source_base_url: Option<&str>,
) -> Result<Option<ConfigDuplicateMatch>, String> {
    let rows = connection
        .prepare(
            "SELECT id, name, raw_config, sources_json, source_base_url FROM config_documents ORDER BY id",
        )
        .map_err(|error| error.to_string())?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let candidate_keys = source_keys
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut best_derived: Option<ConfigDuplicateMatch> = None;
    let mut same_origin: Option<ConfigDuplicateMatch> = None;

    for (document_id, document_name, stored_raw, stored_sources, stored_base) in rows {
        let document_keys = deserialize_sources(stored_sources)?
            .unwrap_or_default()
            .into_iter()
            .map(|source| source.key)
            .collect::<HashSet<_>>();
        let shared_source_count = candidate_keys
            .iter()
            .filter(|key| document_keys.contains(**key))
            .count();

        if stored_raw == raw_config {
            return Ok(Some(ConfigDuplicateMatch {
                document_id,
                document_name,
                kind: "identical".to_string(),
                candidate_source_count: candidate_keys.len(),
                document_source_count: document_keys.len(),
                shared_source_count,
            }));
        }

        let one_contains_the_other = shared_source_count > 0
            && (shared_source_count == candidate_keys.len()
                || shared_source_count == document_keys.len());
        let beats_previous = match &best_derived {
            Some(best) => shared_source_count > best.shared_source_count,
            None => true,
        };
        if one_contains_the_other && beats_previous {
            best_derived = Some(ConfigDuplicateMatch {
                document_id,
                document_name: document_name.clone(),
                kind: "derived".to_string(),
                candidate_source_count: candidate_keys.len(),
                document_source_count: document_keys.len(),
                shared_source_count,
            });
        }

        if same_origin.is_none()
            && source_base_url.is_some()
            && source_base_url == stored_base.as_deref()
        {
            same_origin = Some(ConfigDuplicateMatch {
                document_id,
                document_name,
                kind: "same-origin".to_string(),
                candidate_source_count: candidate_keys.len(),
                document_source_count: document_keys.len(),
                shared_source_count,
            });
        }
    }

    Ok(best_derived.or(same_origin))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create_test_schema(connection: &Connection) {
        connection
            .execute_batch(
                "CREATE TABLE config_documents (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT NOT NULL,
                   raw_config TEXT NOT NULL,
                   normalized_config TEXT NOT NULL,
                   sources_json TEXT,
                   source_base_url TEXT,
                   live_count INTEGER NOT NULL DEFAULT 0,
                   imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE TABLE app_settings (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );",
            )
            .unwrap();
    }

    /// The body of `replace_all_config_documents`, without the Tauri `State` wrapper, so the swap
    /// itself can be tested directly.
    fn replace_all_in_connection(
        connection: &mut Connection,
        name: &str,
        raw_config: &str,
        sources: &[SourceRecord],
    ) -> ConfigDocument {
        let sources_json = serialize_sources(sources).unwrap();
        let transaction = connection.transaction().unwrap();
        transaction.execute("DELETE FROM config_documents", []).unwrap();
        transaction
            .execute(
                "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, source_base_url, live_count) VALUES (?1, ?2, ?3, ?4, NULL, 0)",
                params![name, raw_config, "{}", sources_json],
            )
            .unwrap();
        let id = transaction.last_insert_rowid();
        transaction
            .execute(
                "INSERT INTO app_settings (key, value) VALUES ('active_config_document_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![id.to_string()],
            )
            .unwrap();
        transaction.commit().unwrap();
        load_config_document(connection, id).unwrap().unwrap()
    }

    /// The removal ranking rules, which the hash-lookup rewrite had to preserve exactly.
    ///
    /// `remove_sources_from_config` was rewritten from a nested scan to a hash lookup — measured on the
    /// owner's 1701-source document, **1979 ms to 17.5 ms**. Equivalence was verified against the
    /// original implementation over 12 (case, text) pairs, but that check lived in a temporary script;
    /// these tests keep the rules themselves pinned, because a faster wrong answer is worse than a slow
    /// right one.
    mod removal_ranking {
        use super::*;

        fn site(key: &str, name: &str, api: &str) -> Value {
            json!({ "key": key, "name": name, "api": api, "type": 1 })
        }

        fn record(key: &str, name: &str, api: &str) -> SourceRecord {
            SourceRecord {
                key: key.to_string(),
                name: name.to_string(),
                api: api.to_string(),
                ..test_source_with_key(key, true)
            }
        }

        /// An exact key wins over a name match, even when the name match comes first in the text.
        #[test]
        fn an_exact_key_outranks_an_earlier_name_match() {
            let text = json!({
                "sites": [
                    site("other", "要删的", "https://example.com/api"),
                    site("target", "别删的", "https://example.com/api"),
                ]
            })
            .to_string();

            let removed = vec![record("target", "要删的", "https://example.com/api")];
            // The other entry is what SURVIVES, so it has to be in `remaining` — that list is what the
            // prune treats as "still wanted", and an empty one would legitimately prune everything.
            let remaining = vec![record("other", "别删的", "https://example.com/api")];
            let out = remove_sources_from_config(&text, None, &removed, &remaining);
            let parsed: Value = serde_json::from_str(&out).unwrap();
            let keys: Vec<&str> = parsed["sites"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["key"].as_str().unwrap())
                .collect();

            // Both entries share an identity (same api, no ext), so the ranking is what decides:
            // the entry whose key matches is the one removed.
            assert_eq!(keys, vec!["other"], "the key match should have been removed");
        }

        /// Entries with no address are never matched by identity, because an empty address would
        /// otherwise match a source whose address is equally empty.
        #[test]
        fn an_entry_without_an_address_is_not_matched_by_identity() {
            let text = json!({
                "lives": [
                    { "key": "no-address", "name": "无地址", "channels": [] },
                    site("keep", "保留", "https://example.com/api"),
                ]
            })
            .to_string();

            // A record whose address is empty, which would compare equal to the address-less entry.
            let removed = vec![record("does-not-exist", "无地址", "")];
            let remaining: Vec<SourceRecord> = Vec::new();
            let out = remove_sources_from_config(&text, None, &removed, &remaining);
            let parsed: Value = serde_json::from_str(&out).unwrap();

            assert_eq!(
                parsed["lives"].as_array().unwrap().len(),
                2,
                "an address-less entry must be left alone rather than guessed at"
            );
        }

        /// A record that no longer appears keeps its entry out of the pruned set: the prune only
        /// applies when the text and the list are shown to describe the same document.
        #[test]
        fn an_unrelated_text_is_not_pruned() {
            let text = json!({
                "sites": [
                    site("a", "甲", "https://a.example/api"),
                    site("b", "乙", "https://b.example/api"),
                ]
            })
            .to_string();

            // A single removal whose identity matches nothing in the text at all.
            let removed = vec![record("z", "丙", "https://z.example/api")];
            let remaining = vec![record("q", "丁", "https://q.example/api")];
            let out = remove_sources_from_config(&text, None, &removed, &remaining);
            let parsed: Value = serde_json::from_str(&out).unwrap();

            assert_eq!(
                parsed["sites"].as_array().unwrap().len(),
                2,
                "nothing traceable means the text and list are unrelated, so nothing is pruned"
            );
        }

        /// The same address with different casing and a trailing slash is the same source.
        #[test]
        fn identity_folds_case_and_a_trailing_slash() {
            let text = json!({
                "sites": [site("a", "甲", "https://A.example/API/")],
            })
            .to_string();

            let removed = vec![record("b", "甲", "https://a.example/API")];
            let remaining: Vec<SourceRecord> = Vec::new();
            let out = remove_sources_from_config(&text, None, &removed, &remaining);
            let parsed: Value = serde_json::from_str(&out).unwrap();

            assert!(
                parsed["sites"].as_array().unwrap().is_empty(),
                "case and a trailing slash must not make one address look like two"
            );
        }
    }

    #[test]
    fn collapsing_leaves_exactly_one_document() {
        // The single-configuration model depends on this: after the collapse the user must be
        // looking at one configuration, not at one plus the ghosts of the old ones.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        insert_document_with_sources(&connection, "第一套", "{}", &["a"], None);
        insert_document_with_sources(&connection, "第二套", "{}", &["b"], None);
        insert_document_with_sources(&connection, "第三套", "{}", &["c"], None);

        let merged = replace_all_in_connection(
            &mut connection,
            "中心配置",
            r#"{"sites":[]}"#,
            &[test_source_with_key("a", true), test_source_with_key("b", true)],
        );

        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM config_documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 1);
        assert_eq!(merged.name, "中心配置");
        assert_eq!(merged.sources.len(), 2);
        // The merged document is the active one, or the app would load nothing on next launch.
        assert_eq!(active_config_id(&connection).unwrap(), Some(merged.id));
    }

    #[test]
    fn collapsing_keeps_the_merged_source_state() {
        // The merge is the point of the operation, so the stored snapshot must be the merged one
        // rather than any single original.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        insert_document_with_sources(&connection, "旧", "{}", &["old"], None);

        let mut off = test_source_with_key("kept-off", true);
        off.enabled = false;
        let merged = replace_all_in_connection(
            &mut connection,
            "中心配置",
            r#"{"sites":[]}"#,
            &[test_source_with_key("new", true), off],
        );

        let by_key = |key: &str| {
            merged
                .sources
                .iter()
                .find(|source| source.key == key)
                .unwrap_or_else(|| panic!("{key} missing from the merged document"))
        };
        assert!(by_key("new").enabled);
        // The user's own switch must survive the collapse.
        assert!(!by_key("kept-off").enabled);
    }

    fn test_source(enabled: bool) -> SourceRecord {
        test_source_with_key("shared-key", enabled)
    }

    fn test_source_with_key(key: &str, enabled: bool) -> SourceRecord {
        SourceRecord {
            key: key.to_string(),
            name: "同名源".to_string(),
            source_type: "cms".to_string(),
            source_dialect: None,
            site_type: Some(1),
            site_protocol: Some("json-http".to_string()),
            api: "https://example.com/api".to_string(),
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
            capability_note: "test".to_string(),
            test_status: None,
            test_message: None,
            tested_at: None,
            test_item_count: None,
            test_category_count: None,
            test_duration_ms: None,
            test_operations: Vec::new(),
            enabled,
            last_checked_at: "刚刚".to_string(),
            request_count: 0,
        }
    }

    fn test_live_source() -> SourceRecord {
        let mut source = test_source_with_key("live-relative", true);
        source.name = "相对直播".to_string();
        source.source_type = "live".to_string();
        source.api = "./libs/tv/tvlive.txt".to_string();
        source.site_type = None;
        source.site_protocol = None;
        source.capability = "needs-adapter".to_string();
        source.capability_note = "相对地址需要配置基址".to_string();
        source
    }

    fn insert_test_document(connection: &Connection, name: &str, enabled: bool) -> i64 {
        let sources_json = serialize_sources(&[test_source(enabled)]).unwrap();
        let normalized_config = json!({
            "sites": [{ "key": "shared-key", "enabled": enabled }]
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, live_count) VALUES (?1, ?2, ?3, ?4, 0)",
                params![name, "{}", normalized_config, sources_json],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    fn insert_duplicate_key_document(connection: &Connection) -> i64 {
        let sources_json = serialize_sources(&[
            test_source_with_key("duplicate-key", true),
            test_source_with_key("duplicate-key", true),
        ])
        .unwrap();
        let normalized_config = json!({
            "sites": [{ "key": "duplicate-key" }, { "key": "duplicate-key" }]
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, live_count) VALUES (?1, ?2, ?3, ?4, 0)",
                params!["重复 key 配置", "{}", normalized_config, sources_json],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    #[test]
    fn duplicate_source_keys_are_normalized_and_test_updates_one_source() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let document_id = insert_duplicate_key_document(&connection);

        let loaded = load_config_document(&connection, document_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            loaded
                .sources
                .iter()
                .map(|source| source.key.as_str())
                .collect::<Vec<_>>(),
            ["duplicate-key", "duplicate-key-2"]
        );

        let result = cms::SourceTestResult {
            source_key: "duplicate-key-2".to_string(),
            status: "passed".to_string(),
            adapter_id: "builtin-cms".to_string(),
            message: "识别到影视内容".to_string(),
            item_count: 8,
            category_count: 3,
            duration_ms: 120,
            tested_at: "2025-01-01T00:00:00Z".to_string(),
            operations: Vec::new(),
        };
        let updated =
            set_source_test_in_connection(&mut connection, document_id, "duplicate-key-2", &result)
                .unwrap();
        let updated_value: Value = serde_json::from_str(&updated.normalized_config).unwrap();

        assert_eq!(updated.sources[0].test_status, None);
        assert_eq!(updated.sources[1].test_status.as_deref(), Some("passed"));
        assert_eq!(updated_value["sites"][0]["testStatus"], Value::Null);
        assert_eq!(updated_value["sites"][1]["testStatus"], "passed");
    }

    #[test]
    fn documents_can_store_the_same_source_key_independently() {
        let connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let first_id = insert_test_document(&connection, "主配置", true);
        let second_id = insert_test_document(&connection, "备用配置", false);

        let first = load_config_document(&connection, first_id)
            .unwrap()
            .unwrap();
        let second = load_config_document(&connection, second_id)
            .unwrap()
            .unwrap();

        assert_eq!(first.sources[0].key, second.sources[0].key);
        assert!(first.sources[0].enabled);
        assert!(!second.sources[0].enabled);
    }

    #[test]
    fn source_enablement_updates_only_the_target_document() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let first_id = insert_test_document(&connection, "主配置", true);
        let second_id = insert_test_document(&connection, "备用配置", true);

        let updated =
            set_source_enabled_in_connection(&mut connection, first_id, "shared-key", false)
                .unwrap();
        let untouched = load_config_document(&connection, second_id)
            .unwrap()
            .unwrap();
        let updated_value: Value = serde_json::from_str(&updated.normalized_config).unwrap();
        let untouched_value: Value = serde_json::from_str(&untouched.normalized_config).unwrap();

        assert!(!updated.sources[0].enabled);
        assert_eq!(updated_value["sites"][0]["enabled"], Value::Bool(false));
        assert!(untouched.sources[0].enabled);
        assert_eq!(untouched_value["sites"][0]["enabled"], Value::Bool(true));
    }

    #[test]
    fn source_test_updates_only_the_target_document() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let first_id = insert_test_document(&connection, "主配置", true);
        let second_id = insert_test_document(&connection, "备用配置", true);
        let result = cms::SourceTestResult {
            source_key: "shared-key".to_string(),
            status: "passed".to_string(),
            adapter_id: "builtin-cms".to_string(),
            message: "识别到影视内容".to_string(),
            item_count: 8,
            category_count: 3,
            duration_ms: 120,
            tested_at: "2025-01-01T00:00:00Z".to_string(),
            operations: Vec::new(),
        };

        let updated =
            set_source_test_in_connection(&mut connection, first_id, "shared-key", &result)
                .unwrap();
        let untouched = load_config_document(&connection, second_id)
            .unwrap()
            .unwrap();
        let updated_value: Value = serde_json::from_str(&updated.normalized_config).unwrap();
        let untouched_value: Value = serde_json::from_str(&untouched.normalized_config).unwrap();

        assert_eq!(updated.sources[0].test_status.as_deref(), Some("passed"));
        assert_eq!(updated.sources[0].test_item_count, Some(8));
        assert_eq!(updated.sources[0].request_count, 1);
        assert_eq!(updated_value["sites"][0]["testStatus"], "passed");
        assert_eq!(updated_value["sites"][0]["testItemCount"], 8);
        assert_eq!(untouched.sources[0].test_status, None);
        assert_eq!(untouched_value["sites"][0]["testStatus"], Value::Null);
    }

    #[test]
    fn a_loopback_proxy_wrapper_is_unwrapped_to_its_target() {
        // Configurations imported before this was handled keep the wrapper in their stored
        // snapshot, so reading a document has to correct it rather than requiring a re-import.
        assert_eq!(
            unwrap_local_proxy_url(
                "http://127.0.0.1:9978/proxy?do=live&url=https://x.szyyds.cn/bililive.m3u"
            ),
            "https://x.szyyds.cn/bililive.m3u"
        );
        assert_eq!(
            unwrap_local_proxy_url("http://localhost:9978/proxy?url=https://example.com/a.m3u"),
            "https://example.com/a.m3u"
        );
    }

    #[test]
    fn a_remote_url_that_merely_has_a_url_parameter_is_left_alone() {
        // Only a loopback host is a local proxy; a real server taking a `url` parameter must be
        // requested exactly as given.
        for url in [
            "https://example.com/proxy?url=https://other.example/x.m3u",
            "https://example.com/api.php/provide/vod/",
            "./libs/tv/tvlive.txt",
            "http://127.0.0.1:9978/proxy?do=live",
            "http://127.0.0.1:9978/proxy?url=file:///etc/passwd",
        ] {
            assert_eq!(unwrap_local_proxy_url(url), url, "{url} should be unchanged");
        }
    }

    #[test]
    fn stored_sources_are_unwrapped_when_read() {
        let sources = vec![test_live_source()];
        let mut wrapped = sources.clone();
        wrapped[0].api =
            "http://127.0.0.1:9978/proxy?do=live&url=https://x.szyyds.cn/bililive.m3u".to_string();

        let read = deserialize_sources(Some(serialize_sources(&wrapped).unwrap()))
            .unwrap()
            .unwrap();

        assert_eq!(read[0].api, "https://x.szyyds.cn/bililive.m3u");
    }

    #[test]
    fn a_failed_test_switches_the_source_off() {
        // A source proved broken must stop being offered, in the stored snapshot and in the
        // exported configuration alike. Leaving it enabled would keep listing it in the library.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let document_id = insert_test_document(&connection, "配置", true);

        let result = cms::SourceTestResult {
            source_key: "shared-key".to_string(),
            status: "failed".to_string(),
            adapter_id: "builtin-cms".to_string(),
            message: "请求失败".to_string(),
            item_count: 0,
            category_count: 0,
            duration_ms: 30,
            tested_at: "2025-01-01T00:00:00Z".to_string(),
            operations: Vec::new(),
        };

        let updated =
            set_source_test_in_connection(&mut connection, document_id, "shared-key", &result)
                .unwrap();
        let value: Value = serde_json::from_str(&updated.normalized_config).unwrap();

        assert!(!updated.sources[0].enabled);
        assert_eq!(value["sites"][0]["enabled"], Value::Bool(false));
        assert_eq!(updated.sources[0].test_status.as_deref(), Some("failed"));
    }

    #[test]
    fn an_empty_test_switches_the_source_off() {
        // "Request succeeded but there is nothing to watch" is not usable either.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let document_id = insert_test_document(&connection, "配置", true);

        let result = cms::SourceTestResult {
            source_key: "shared-key".to_string(),
            status: "empty".to_string(),
            adapter_id: "builtin-cms".to_string(),
            message: "响应中没有内容".to_string(),
            item_count: 0,
            category_count: 0,
            duration_ms: 30,
            tested_at: "2025-01-01T00:00:00Z".to_string(),
            operations: Vec::new(),
        };

        let updated =
            set_source_test_in_connection(&mut connection, document_id, "shared-key", &result)
                .unwrap();

        assert!(!updated.sources[0].enabled);
    }

    #[test]
    fn a_passing_test_leaves_the_source_switched_on() {
        // Passing must not silently re-enable something the user turned off deliberately.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let document_id = insert_test_document(&connection, "配置", true);

        let result = cms::SourceTestResult {
            source_key: "shared-key".to_string(),
            status: "passed".to_string(),
            adapter_id: "builtin-cms".to_string(),
            message: "请求成功".to_string(),
            item_count: 5,
            category_count: 2,
            duration_ms: 30,
            tested_at: "2025-01-01T00:00:00Z".to_string(),
            operations: Vec::new(),
        };

        let updated =
            set_source_test_in_connection(&mut connection, document_id, "shared-key", &result)
                .unwrap();

        assert!(updated.sources[0].enabled);
    }

    #[test]
    fn a_failure_that_never_reached_the_server_still_switches_the_source_off() {
        // **The rule the user asked for, and the reverse of what this test asserted before.** A
        // source we cannot reach is a source we cannot use: a timeout, a name that did not resolve
        // and a refused connection are 测试失败 like any other, so they switch the source off and
        // land it in the same 清理不可用 set. The old rule exempted them on the theory that they
        // report the network rather than the source, which left unusable sources switched on and
        // therefore still offered in the library — the thing the user objected to.
        for message in [
            "CMS 响应请求失败：error sending request for url (https://ikunzyapi.com/...)；client error (Connect)；远程主机强迫关闭了一个现有的连接。 (os error 10054)",
            "无法解析远程主机：不知道这样的主机。 (os error 11001)",
            "测试超时（25 秒），已停止等待。该源可能无法访问或响应过慢。",
        ] {
            let mut connection = Connection::open_in_memory().unwrap();
            create_test_schema(&connection);
            let document_id = insert_test_document(&connection, "配置", true);

            let result = cms::SourceTestResult {
                source_key: "shared-key".to_string(),
                status: "failed".to_string(),
                adapter_id: "builtin-cms".to_string(),
                message: message.to_string(),
                item_count: 0,
                category_count: 0,
                duration_ms: 30,
                tested_at: "2025-01-01T00:00:00Z".to_string(),
                operations: Vec::new(),
            };

            let updated =
                set_source_test_in_connection(&mut connection, document_id, "shared-key", &result)
                    .unwrap();

            assert!(
                !updated.sources[0].enabled,
                "an unreachable source must be switched off like any other failure: {message}"
            );
            // The failure is still recorded, so the user can see what happened.
            assert_eq!(updated.sources[0].test_status.as_deref(), Some("failed"));
        }
    }

    #[test]
    fn an_answered_failure_still_switches_the_source_off() {
        // The counterpart: when the server answered, the verdict is about the source and stands.
        for message in [
            "CMS 响应返回错误状态：HTTP 404；Not Found",
            "CMS 响应不是有效 JSON：expected value at line 1 column 1",
            "d.kstore.space 解析到本机或局域网地址，Moseek 不会请求它",
        ] {
            let mut connection = Connection::open_in_memory().unwrap();
            create_test_schema(&connection);
            let document_id = insert_test_document(&connection, "配置", true);

            let result = cms::SourceTestResult {
                source_key: "shared-key".to_string(),
                status: "failed".to_string(),
                adapter_id: "builtin-cms".to_string(),
                message: message.to_string(),
                item_count: 0,
                category_count: 0,
                duration_ms: 30,
                tested_at: "2025-01-01T00:00:00Z".to_string(),
                operations: Vec::new(),
            };

            let updated =
                set_source_test_in_connection(&mut connection, document_id, "shared-key", &result)
                    .unwrap();

            assert!(
                !updated.sources[0].enabled,
                "an answered failure must switch the source off: {message}"
            );
        }
    }

    #[test]
    fn a_passing_test_does_not_re_enable_a_disabled_source() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let document_id = insert_test_document(&connection, "配置", false);

        let result = cms::SourceTestResult {
            source_key: "shared-key".to_string(),
            status: "passed".to_string(),
            adapter_id: "builtin-cms".to_string(),
            message: "请求成功".to_string(),
            item_count: 5,
            category_count: 2,
            duration_ms: 30,
            tested_at: "2025-01-01T00:00:00Z".to_string(),
            operations: Vec::new(),
        };

        let updated =
            set_source_test_in_connection(&mut connection, document_id, "shared-key", &result)
                .unwrap();

        assert!(!updated.sources[0].enabled);
    }

    #[test]
    fn source_base_url_resolves_relative_live_sources() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let source = test_live_source();
        let sources_json = serialize_sources(&[source]).unwrap();
        connection
            .execute(
                "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, live_count) VALUES (?1, ?2, ?3, ?4, 1)",
                params![
                    "直播基址配置",
                    "{}",
                    r#"{"lives":[{"key":"live-relative","api":"./libs/tv/tvlive.txt","capability":"needs-adapter"}]}"#,
                    sources_json
                ],
            )
            .unwrap();
        let document_id = connection.last_insert_rowid();

        let updated = set_config_source_base_url(
            &mut connection,
            document_id,
            "https://example.com/config/config.json",
        )
        .unwrap();

        assert_eq!(
            updated.sources[0].api,
            "https://example.com/config/libs/tv/tvlive.txt"
        );
        assert_eq!(updated.sources[0].capability, "supported");
        assert_eq!(
            updated.source_base_url.as_deref(),
            Some("https://example.com/config/config.json")
        );
        assert_eq!(
            serde_json::from_str::<Value>(&updated.normalized_config).unwrap()["lives"][0]["api"],
            "https://example.com/config/libs/tv/tvlive.txt"
        );
    }

    fn insert_document_with_sources(
        connection: &Connection,
        name: &str,
        raw_config: &str,
        keys: &[&str],
        source_base_url: Option<&str>,
    ) -> i64 {
        let sources = keys
            .iter()
            .map(|key| test_source_with_key(key, true))
            .collect::<Vec<_>>();
        let sources_json = serialize_sources(&sources).unwrap();
        connection
            .execute(
                "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, source_base_url, live_count) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                params![name, raw_config, "{}", sources_json, source_base_url],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    #[test]
    fn removing_sources_drops_them_from_both_the_snapshot_and_the_raw_config() {
        // A pruned source has to leave the raw text too. If only the snapshot were updated, the
        // next import or export would bring the source straight back, which is exactly what the
        // user was trying to get rid of.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"sites":[{"key":"keep","name":"保留"},{"key":"drop","name":"删除"}],"lives":[{"key":"droplive"}]}"#;
        connection
            .execute(
                "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, live_count) VALUES (?1, ?2, ?3, ?4, 1)",
                params![
                    "可清理配置",
                    raw,
                    raw,
                    serialize_sources(&[
                        test_source_with_key("keep", true),
                        test_source_with_key("drop", true),
                        test_live_source(),
                    ])
                    .unwrap()
                ],
            )
            .unwrap();
        let document_id = connection.last_insert_rowid();

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["drop".to_string()],
        )
        .unwrap();

        assert_eq!(updated.sources.len(), 2);
        assert!(updated.sources.iter().all(|source| source.key != "drop"));

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        let site_keys: Vec<&str> = raw_value["sites"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["key"].as_str())
            .collect();
        assert_eq!(site_keys, vec!["keep"]);

        let normalized: Value = serde_json::from_str(&updated.normalized_config).unwrap();
        assert_eq!(normalized["sites"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn removing_sources_updates_the_stored_counts() {
        // The document list shows these counts, so leaving them stale would report sources that
        // are no longer there.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"sites":[{"key":"a"},{"key":"b"}],"lives":[{"key":"live-relative"}]}"#;
        connection
            .execute(
                "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, live_count) VALUES (?1, ?2, ?3, ?4, 1)",
                params![
                    "计数配置",
                    raw,
                    raw,
                    serialize_sources(&[
                        test_source_with_key("a", true),
                        test_source_with_key("b", true),
                        test_live_source(),
                    ])
                    .unwrap()
                ],
            )
            .unwrap();
        let document_id = connection.last_insert_rowid();

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["b".to_string(), "live-relative".to_string()],
        )
        .unwrap();

        assert_eq!(updated.sources.len(), 1);
        assert_eq!(updated.live_count, 0);
    }

    #[test]
    fn removing_a_source_that_is_not_there_is_rejected() {
        // Silently succeeding would let a stale UI report a deletion that never happened.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let document_id =
            insert_document_with_sources(&connection, "配置 A", "{\"a\":1}", &["a"], None);

        let error = match remove_sources_in_connection(
            &mut connection,
            document_id,
            &["missing".to_string()],
        ) {
            Ok(_) => panic!("removing an absent source should be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("找不到"), "unexpected error: {error}");
        let unchanged = load_config_document(&connection, document_id)
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.sources.len(), 1);
    }

    #[test]
    fn removing_sources_leaves_unparseable_raw_config_untouched() {
        // The raw text is whatever the user imported. If it cannot be parsed, a removal must not
        // replace it with an empty object — that would destroy their configuration.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let document_id = insert_document_with_sources(
            &connection,
            "坏配置",
            "not json at all",
            &["a", "b"],
            None,
        );

        let updated =
            remove_sources_in_connection(&mut connection, document_id, &["a".to_string()])
                .unwrap();

        assert_eq!(updated.raw_config, "not json at all");
        assert_eq!(updated.sources.len(), 1);
    }

    #[test]
    fn removing_sources_only_affects_the_target_document() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let first = insert_document_with_sources(&connection, "配置 A", "{\"a\":1}", &["a", "b"], None);
        let second = insert_document_with_sources(&connection, "配置 B", "{\"b\":1}", &["a", "b"], None);

        remove_sources_in_connection(&mut connection, first, &["a".to_string()]).unwrap();

        let other = load_config_document(&connection, second).unwrap().unwrap();
        assert_eq!(other.sources.len(), 2);
    }

    #[test]
    fn duplicate_detection_reports_identical_content() {
        let connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        insert_document_with_sources(&connection, "配置 A", "{\"a\":1}", &["a", "b"], None);

        let found = find_config_duplicate(
            &connection,
            "{\"a\":1}",
            &["a".to_string(), "b".to_string()],
            None,
        )
        .unwrap()
        .expect("identical content should match");

        assert_eq!(found.kind, "identical");
        assert_eq!(found.document_name, "配置 A");
        assert_eq!(found.shared_source_count, 2);
    }

    #[test]
    fn duplicate_detection_catches_a_trimmed_copy_of_an_imported_configuration() {
        // The user imported a configuration, deleted the sources they did not want, and now
        // re-imports the untouched original. The text differs, so only the source sets reveal
        // that they already have it.
        let connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        insert_document_with_sources(
            &connection,
            "配置 A",
            "{\"trimmed\":true}",
            &["a", "b"],
            None,
        );

        let found = find_config_duplicate(
            &connection,
            "{\"original\":true}",
            &["a".to_string(), "b".to_string(), "c".to_string()],
            None,
        )
        .unwrap()
        .expect("a superset of a stored document should match");

        assert_eq!(found.kind, "derived");
        assert_eq!(found.shared_source_count, 2);
        assert_eq!(found.candidate_source_count, 3);
        assert_eq!(found.document_source_count, 2);
    }

    #[test]
    fn duplicate_detection_catches_an_import_that_is_a_trimmed_copy() {
        let connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        insert_document_with_sources(&connection, "配置 A", "{\"a\":1}", &["a", "b", "c"], None);

        let found = find_config_duplicate(
            &connection,
            "{\"b\":2}",
            &["a".to_string(), "b".to_string()],
            None,
        )
        .unwrap()
        .expect("a subset of a stored document should match");

        assert_eq!(found.kind, "derived");
        assert_eq!(found.shared_source_count, 2);
        assert_eq!(found.document_source_count, 3);
    }

    #[test]
    fn duplicate_detection_prefers_the_closest_source_overlap() {
        let connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        insert_document_with_sources(&connection, "小的", "{\"a\":1}", &["a"], None);
        insert_document_with_sources(&connection, "大的", "{\"b\":1}", &["a", "b"], None);

        let found = find_config_duplicate(
            &connection,
            "{\"c\":2}",
            &["a".to_string(), "b".to_string(), "c".to_string()],
            None,
        )
        .unwrap()
        .expect("both documents are subsets, the larger overlap wins");

        assert_eq!(found.document_name, "大的");
        assert_eq!(found.shared_source_count, 2);
    }

    #[test]
    fn duplicate_detection_falls_back_to_the_import_address() {
        let connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        insert_document_with_sources(
            &connection,
            "配置 A",
            "{\"a\":1}",
            &["a"],
            Some("https://example.com/tv/x.json"),
        );

        let found = find_config_duplicate(
            &connection,
            "{\"b\":2}",
            &["z".to_string()],
            Some("https://example.com/tv/x.json"),
        )
        .unwrap()
        .expect("the same import address should match");

        assert_eq!(found.kind, "same-origin");
    }

    #[test]
    fn duplicate_detection_stays_quiet_for_unrelated_configurations() {
        let connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        insert_document_with_sources(&connection, "配置 A", "{\"a\":1}", &["a", "b"], None);

        assert!(
            find_config_duplicate(&connection, "{\"c\":3}", &["x".to_string()], None)
                .unwrap()
                .is_none()
        );
        assert!(find_config_duplicate(
            &connection,
            "{\"c\":3}",
            &["x".to_string()],
            Some("https://example.com/other.json")
        )
        .unwrap()
        .is_none());
    }

    /// A site whose address is distinct, so identity-matching tests can tell entries apart.
    fn test_site(key: &str, name: &str, api: &str) -> SourceRecord {
        let mut source = test_source_with_key(key, true);
        source.name = name.to_string();
        source.api = api.to_string();
        source
    }

    /// A live source whose address is distinct.
    fn test_live(key: &str, name: &str, api: &str) -> SourceRecord {
        let mut source = test_source_with_key(key, true);
        source.name = name.to_string();
        source.source_type = "live".to_string();
        source.api = api.to_string();
        source.site_type = None;
        source.site_protocol = None;
        source
    }

    fn insert_document_with_records(
        connection: &Connection,
        raw_config: &str,
        sources: &[SourceRecord],
        source_base_url: Option<&str>,
    ) -> i64 {
        connection
            .execute(
                "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, source_base_url, live_count) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                params![
                    "配置",
                    raw_config,
                    "{}",
                    serialize_sources(sources).unwrap(),
                    source_base_url
                ],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    #[test]
    fn removing_a_source_whose_key_the_parser_invented_clears_the_raw_entry() {
        // The reported bug. A live entry that declares no `key` is named `live-1` by the parser but
        // `-2` by the merge (which suffixes the blank key it sees), so a removal matched on `key`
        // found nothing and the entry stayed in the raw configuration — the user deleted a source
        // and it was still there.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"lives":[{"name":"直播","url":"http://a.example/list.txt"},{"name":"肥猫","url":"http://b.example/tv.txt"},{"name":"SAO0","url":"http://c.example/tv.txt"}]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[
                test_live("live-1", "直播", "http://a.example/list.txt"),
                test_live("live-2", "肥猫", "http://b.example/tv.txt"),
                test_live("live-3", "SAO0", "http://c.example/tv.txt"),
            ],
            None,
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["live-2".to_string()],
        )
        .unwrap();

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        let names: Vec<&str> = raw_value["lives"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["name"].as_str())
            .collect();

        assert_eq!(
            names,
            vec!["直播", "SAO0"],
            "the deleted live entry must leave the raw configuration: {}",
            updated.raw_config
        );
        assert_eq!(updated.sources.len(), 2);
    }

    #[test]
    fn removing_a_site_whose_raw_key_differs_by_whitespace_clears_the_raw_entry() {
        // The second shape of the same symptom: the author's key carried padding (`"一起看 "`), so
        // the stored key and the parser's trimmed key were different strings and the removal missed.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"sites":[{"key":"一起看 ","name":"一起看","api":"csp_YQKan"},{"key":"keep","name":"保留","api":"csp_Keep"}]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[
                test_site("一起看", "一起看", "csp_YQKan"),
                test_site("keep", "保留", "csp_Keep"),
            ],
            None,
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["一起看".to_string()],
        )
        .unwrap();

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        let keys: Vec<&str> = raw_value["sites"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["key"].as_str())
            .collect();

        assert_eq!(keys, vec!["keep"], "raw config was: {}", updated.raw_config);
    }

    #[test]
    fn removing_a_relative_source_matches_the_resolved_spelling_in_the_raw_text() {
        // The raw text keeps the address as written (`./libs/tv/tvlive.txt`); the source list holds
        // what the import resolved against the base URL. Matching has to canonicalise both, or a
        // relative source can never be deleted from the raw configuration.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"sites":[{"key":"relative","name":"相对","api":"./libs/tv/tvlive.txt"},{"key":"keep","name":"保留","api":"csp_Keep"}]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[
                test_site("relative", "相对", "https://example.com/config/libs/tv/tvlive.txt"),
                test_site("keep", "保留", "csp_Keep"),
            ],
            Some("https://example.com/config/config.json"),
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["relative".to_string()],
        )
        .unwrap();

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        let keys: Vec<&str> = raw_value["sites"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["key"].as_str())
            .collect();

        assert_eq!(keys, vec!["keep"], "raw config was: {}", updated.raw_config);
    }

    #[test]
    fn removing_a_recovered_live_source_clears_the_raw_entry_it_was_recovered_from() {
        // The real shape, measured on the author's configuration. `replace_known_live_source_urls`
        // rewrites the source list to a working absolute URL and, in the same statement, sets
        // `source_base_url` to NULL — but it never touches `raw_config`, which still spells the
        // address relatively (`./libs/tv/tvlive.txt`).
        //
        // So the two sides differ in a way the base URL can no longer bridge: there is no base to
        // resolve the relative spelling against. The invariant is that deleting such a source must
        // still clear its raw entry, or the user meets the "I deleted it but it is still in my
        // configuration" bug again for exactly the entries the app itself repaired.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"lives":[{"key":"-4","name":"SAO0","url":"./libs/tv/tvlive.txt"},{"key":"keep","name":"保留","url":"https://keep.example/tv.txt"}]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[
                // The recovered record: absolute, and no base URL on the document.
                test_live("live-2-2", "SAO0", "https://iptv-org.github.io/iptv/countries/cn.m3u"),
                test_live("keep", "保留", "https://keep.example/tv.txt"),
            ],
            None,
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["live-2-2".to_string()],
        )
        .unwrap();

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        let names: Vec<&str> = raw_value["lives"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["name"].as_str())
            .collect();

        assert_eq!(names, vec!["保留"], "raw config was: {}", updated.raw_config);
    }

    #[test]
    fn replacing_a_recovered_url_rewrites_the_raw_text_too() {
        // The three stores have to agree. Only the source list carried the recovered URL, so the raw
        // text kept `./libs/tv/tvlive.txt`; anything that later re-derives the normalised form from
        // the raw text (an import, or a save from the raw tab) would put the old address back and
        // silently undo the repair. Matching is by name because the raw key (`-4`) is the author's
        // and the list key (`live-2-2`) is the parser's.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"lives":[{"key":"-4","name":"SAO0","url":"./libs/tv/tvlive.txt"},{"key":"keep","name":"保留","url":"https://keep.example/tv.txt"}],"sites":[{"key":"s","name":"站点","api":"https://s.example/api"}]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[
                test_live("live-2-2", "SAO0", "./libs/tv/tvlive.txt"),
                test_live("keep", "保留", "https://keep.example/tv.txt"),
                test_site("s", "站点", "https://s.example/api"),
            ],
            Some("https://szyyds.cn/tv/x.json"),
        );

        let mut replacements = HashMap::new();
        replacements.insert(
            "live-2-2".to_string(),
            "https://iptv-org.github.io/iptv/countries/cn.m3u".to_string(),
        );
        let updated = replace_known_live_source_urls(&mut connection, document_id, &replacements)
            .unwrap()
            .expect("the replacement must produce a document");

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        let lives = raw_value["lives"].as_array().unwrap();
        assert_eq!(
            lives[0]["url"].as_str(),
            Some("https://iptv-org.github.io/iptv/countries/cn.m3u"),
            "raw config was: {}",
            updated.raw_config
        );
        // The recovered entry was the only one meant to change.
        assert_eq!(lives[1]["url"].as_str(), Some("https://keep.example/tv.txt"));
        // An unrelated section is left exactly as it was.
        assert_eq!(
            raw_value["sites"][0]["api"].as_str(),
            Some("https://s.example/api")
        );
    }

    #[test]
    fn replacing_a_recovered_url_leaves_an_unreadable_raw_text_alone() {
        // A removal must never empty a document it cannot parse, and the same holds here: the
        // recovery rewrites three stores, and one of them being unreadable must not become an empty
        // configuration. The list still moves, because that is what the user sees working.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let document_id = insert_document_with_records(
            &connection,
            "{ not json",
            &[test_live("live-2-2", "SAO0", "./libs/tv/tvlive.txt")],
            Some("https://szyyds.cn/tv/x.json"),
        );

        let mut replacements = HashMap::new();
        replacements.insert(
            "live-2-2".to_string(),
            "https://iptv-org.github.io/iptv/countries/cn.m3u".to_string(),
        );
        let updated = replace_known_live_source_urls(&mut connection, document_id, &replacements)
            .unwrap()
            .expect("the replacement must produce a document");

        assert_eq!(updated.raw_config, "{ not json");
        assert_eq!(
            updated.sources[0].api,
            "https://iptv-org.github.io/iptv/countries/cn.m3u"
        );
    }

    /// The base URL of a document, for tests that check the identity invariant directly.
    fn base_url_of(document: &ConfigDocument) -> Option<Url> {
        document
            .source_base_url
            .as_deref()
            .and_then(|value| Url::parse(value.trim()).ok())
            .filter(|url| matches!(url.scheme(), "http" | "https"))
    }

    /// Every addressable entry left in a text that the list no longer claims, by section.
    ///
    /// This is the invariant a removal has to leave behind: a source the user deleted must not still
    /// be sitting in their configuration. Returning the leftovers rather than a count keeps the
    /// failure message useful — it names what survived.
    fn unclaimed_entries(document: &ConfigDocument) -> Vec<String> {
        let Ok(raw) = serde_json::from_str::<Value>(&document.raw_config) else {
            return Vec::new();
        };
        let base = base_url_of(document);
        let kept_identities: HashSet<String> = document
            .sources
            .iter()
            .map(|source| record_identity(source, base.as_ref()))
            .collect();
        let kept_labels: HashSet<String> = document
            .sources
            .iter()
            .map(|source| source.name.trim().to_lowercase())
            .collect();

        let mut leftovers = Vec::new();
        for (section, is_live) in [("sites", false), ("lives", true)] {
            let Some(items) = raw[section].as_array() else {
                continue;
            };
            for item in items {
                if entry_address(item, is_live).trim().is_empty() {
                    continue;
                }
                if kept_identities.contains(&entry_identity(item, is_live, base.as_ref())) {
                    continue;
                }
                let label = entry_label(item);
                if !label.is_empty() && kept_labels.contains(&label) {
                    continue;
                }
                leftovers.push(format!(
                    "{section} key={:?} name={:?} api={:?}",
                    item.get("key"),
                    item.get("name"),
                    entry_address(item, is_live)
                ));
            }
        }
        leftovers
    }

    #[test]
    fn a_removal_leaves_no_entry_the_list_no_longer_claims() {
        // The reported symptom, as an invariant rather than a single case: the raw text held entries
        // the list had already lost (11 lives in the author's own configuration), which is exactly
        // the "I deleted a source but it is still in the original configuration" report. A removal
        // must clear them, not only the source being deleted now.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        // `live-1` declares no key and the text holds three more entries than the list, mirroring
        // the author's document: 15 raw lives against 5 in the list.
        let raw = r#"{"sites":[],"lives":[
            {"name":"直播","url":"http://a.example/list.txt"},
            {"key":"-2","name":"肥猫","url":"http://b.example/tv.txt"},
            {"key":"-3","name":"SAO0","url":"http://c.example/tv.txt"},
            {"key":"-4","name":"咪咕","url":"http://d.example/tv.txt"},
            {"key":"-5","name":"一起看","url":"http://e.example/tv.txt"}
        ]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[
                test_live("live-1", "直播", "http://a.example/list.txt"),
                test_live("live-2", "SAO0", "http://c.example/tv.txt"),
            ],
            None,
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["live-1".to_string()],
        )
        .unwrap();

        let leftovers = unclaimed_entries(&updated);
        assert!(
            leftovers.is_empty(),
            "entries the list no longer claims survived the removal:\n{}",
            leftovers.join("\n")
        );
    }

    #[test]
    fn removing_matches_by_identity_when_the_counts_are_equal() {
        // Isolates the identity match from the leftover-pruning step. Pruning only runs when the
        // text holds MORE entries than the list, so with the counts equal the removed source must be
        // found by identity — the text here declares no keys at all, which is exactly the shape that
        // used to survive a deletion.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"sites":[{"name":"要删的","api":"http://gone.example/api"},{"name":"保留的","api":"http://keep.example/api"}]}"#;
        // The list holds one more source than the text, so after this removal the counts are equal.
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[
                test_site("site-3", "要删的", "http://gone.example/api"),
                test_site("site-1", "保留的", "http://keep.example/api"),
                test_site("site-2", "另一个", "http://other.example/api"),
            ],
            None,
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["site-3".to_string()],
        )
        .unwrap();

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        let names: Vec<&str> = raw_value["sites"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["name"].as_str())
            .collect();

        assert_eq!(
            names,
            vec!["保留的"],
            "identity matching must remove the entry the key cannot name: {}",
            updated.raw_config
        );
    }

    #[test]
    fn an_unrelated_text_is_not_pruned() {
        // The guard on the pruning step. When the list explains almost nothing about the text, the
        // two are not the same document — pruning would then delete sources the user never removed.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"sites":[{"key":"a","name":"甲","api":"http://a.example/api"},{"key":"b","name":"乙","api":"http://b.example/api"},{"key":"c","name":"丙","api":"http://c.example/api"},{"key":"d","name":"丁","api":"http://d.example/api"}]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[test_site("unrelated", "无关", "http://unrelated.example/api")],
            None,
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["unrelated".to_string()],
        )
        .unwrap();

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        assert_eq!(
            raw_value["sites"].as_array().unwrap().len(),
            4,
            "an unrelated text must be left intact: {}",
            updated.raw_config
        );
    }

    #[test]
    fn removing_one_of_two_sources_sharing_an_identity_keeps_the_other() {
        // Identity is not unique: `xgapp` and `骑骑影院` are the same adapter with the same `ext`.
        // Matching on identity alone would delete both, so the match has to be refined — a removal
        // must claim exactly one raw entry per source.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"sites":[{"key":"xgapp","name":"西瓜","api":"csp_AppYsV2","ext":{"a":1}},{"key":"骑骑影院","name":"骑骑","api":"csp_AppYsV2","ext":{"a":1}}]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[
                test_site("xgapp", "西瓜", "csp_AppYsV2"),
                test_site("骑骑影院", "骑骑", "csp_AppYsV2"),
            ],
            None,
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["xgapp".to_string()],
        )
        .unwrap();

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        let keys: Vec<&str> = raw_value["sites"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["key"].as_str())
            .collect();

        assert_eq!(
            keys,
            vec!["骑骑影院"],
            "only the removed source may leave the text: {}",
            updated.raw_config
        );
    }

    #[test]
    fn removing_also_prunes_an_entry_the_list_had_already_lost() {
        // The user's actual report: the source was already gone from the list, yet the raw text
        // still held it, so it reappeared on import. A later removal has to clear that leftover —
        // not only the source being deleted now.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"sites":[{"key":"keep","name":"保留","api":"csp_Keep"},{"key":"gone","name":"已删除","api":"csp_Gone"}]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[test_site("keep", "保留", "csp_Keep")],
            None,
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["keep".to_string()],
        )
        .unwrap();

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        assert_eq!(
            raw_value["sites"].as_array().unwrap().len(),
            0,
            "a entry the list no longer has must not survive the removal: {}",
            updated.raw_config
        );
    }

    #[test]
    fn an_entry_that_cannot_be_identified_is_left_alone() {
        // A live entry may carry nested `channels` instead of an address. It cannot be matched to a
        // source, so the prune must leave it rather than guess — deleting a user's configuration is
        // worse than keeping an entry they may still want.
        let mut connection = Connection::open_in_memory().unwrap();
        create_test_schema(&connection);
        let raw = r#"{"lives":[{"name":"保留","url":"http://a.example/list.txt"},{"name":"重定向","group":"redirect","channels":[{"name":"live","urls":["proxy://do=live"]}]}]}"#;
        let document_id = insert_document_with_records(
            &connection,
            raw,
            &[test_live("live-1", "保留", "http://a.example/list.txt")],
            None,
        );

        let updated = remove_sources_in_connection(
            &mut connection,
            document_id,
            &["live-1".to_string()],
        )
        .unwrap();

        let raw_value: Value = serde_json::from_str(&updated.raw_config).unwrap();
        let items = raw_value["lives"].as_array().unwrap();
        assert_eq!(
            items.len(),
            1,
            "an entry without an address must survive: {}",
            updated.raw_config
        );
        assert_eq!(items[0]["name"].as_str(), Some("重定向"));
    }
}
