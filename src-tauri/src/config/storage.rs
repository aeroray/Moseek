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
                script_archive_id: None,
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
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE config_documents SET sources_json = ?1, normalized_config = ?2, source_base_url = NULL WHERE id = ?3",
            params![sources_json, normalized_config, document_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    load_config_document(connection, document_id).map_err(|error| error.to_string())
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

fn update_normalized_source_script_archive(
    normalized_config: &str,
    source_key: &str,
    archive_id: Option<i64>,
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
                let value = archive_id
                    .map(|id| Value::Number(id.into()))
                    .unwrap_or(Value::Null);
                object.insert("scriptArchiveId".to_string(), value);
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

    let removing: std::collections::HashSet<&str> =
        source_keys.iter().map(String::as_str).collect();
    let sources: Vec<SourceRecord> = document
        .sources
        .iter()
        .filter(|source| !removing.contains(source.key.as_str()))
        .cloned()
        .collect();
    if sources.len() == document.sources.len() {
        return Err("配置中找不到要删除的源".to_string());
    }

    let sources_json = serialize_sources(&sources)?;
    let normalized_config =
        remove_sources_from_config(&document.normalized_config, &removing);
    let raw_config = remove_sources_from_config(&document.raw_config, &removing);
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

/// Drops matching entries from the `sites` / `lives` arrays of a configuration text.
///
/// Returns the input unchanged when it is not parseable, so an unparseable configuration is never
/// silently emptied by a removal.
fn remove_sources_from_config(
    config_text: &str,
    removing: &std::collections::HashSet<&str>,
) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(config_text) else {
        return config_text.to_string();
    };
    let Some(object) = value.as_object_mut() else {
        return config_text.to_string();
    };
    for section in ["sites", "lives"] {
        let Some(items) = object.get_mut(section).and_then(Value::as_array_mut) else {
            continue;
        };
        items.retain(|item| {
            item.get("key")
                .and_then(Value::as_str)
                .map(|key| !removing.contains(key))
                .unwrap_or(true)
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

pub(super) fn set_source_script_archive_in_connection(
    connection: &mut Connection,
    document_id: i64,
    source_key: &str,
    archive_id: Option<i64>,
) -> Result<ConfigDocument, String> {
    if let Some(archive_id) = archive_id {
        let exists = connection
            .query_row(
                "SELECT 1 FROM script_archives WHERE id = ?1 AND deleted_at IS NULL",
                params![archive_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if exists.is_none() {
            return Err("脚本档案不存在、已删除或不可用".to_string());
        }
    }
    let document = load_config_document(connection, document_id)?
        .ok_or_else(|| "配置不存在或已被删除".to_string())?;
    let mut sources = document.sources.clone();
    let source = sources
        .iter_mut()
        .find(|source| source.key == source_key)
        .ok_or_else(|| "配置中找不到该资源源".to_string())?;
    source.script_archive_id = archive_id;
    let sources_json = serialize_sources(&sources)?;
    let normalized_config = update_normalized_source_script_archive(
        &document.normalized_config,
        source_key,
        archive_id,
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
        .ok_or_else(|| "绑定保存后无法读取配置".to_string())
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
        if result.status == "failed" || result.status == "empty" {
            source.enabled = false;
        }
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

pub(crate) fn clear_script_archive_bindings(
    connection: &mut Connection,
    archive_id: i64,
) -> Result<(), String> {
    let rows = connection
        .prepare("SELECT id, normalized_config, sources_json FROM config_documents")
        .map_err(|error| error.to_string())?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for (document_id, normalized_config, sources_json) in rows {
        let Some(mut sources) = deserialize_sources(sources_json)? else {
            continue;
        };
        let bound_keys = sources
            .iter_mut()
            .filter_map(|source| {
                if source.script_archive_id == Some(archive_id) {
                    source.script_archive_id = None;
                    Some(source.key.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        if bound_keys.is_empty() {
            continue;
        }
        let sources_json = serialize_sources(&sources)?;
        let normalized_config = bound_keys
            .iter()
            .fold(normalized_config, |config, source_key| {
                update_normalized_source_script_archive(&config, source_key, None)
            });
        transaction
            .execute(
                "UPDATE config_documents SET sources_json = ?1, normalized_config = ?2 WHERE id = ?3",
                params![sources_json, normalized_config, document_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
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
                 );",
            )
            .unwrap();
    }

    fn test_source(enabled: bool) -> SourceRecord {
        test_source_with_key("shared-key", enabled)
    }

    fn test_source_with_key(key: &str, enabled: bool) -> SourceRecord {
        SourceRecord {
            key: key.to_string(),
            name: "同名源".to_string(),
            source_type: "cms".to_string(),
            script_archive_id: None,
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
}
