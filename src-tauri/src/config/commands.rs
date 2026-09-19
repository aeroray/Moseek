use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;
use tauri::State;

use crate::{
    cms, policy, AppDatabase, ConfigDocument, ConfigDocumentSummary, ConfigDuplicateMatch,
    SaveConfigDocumentInput,
};

use super::storage;

#[tauri::command]
pub fn save_config_document(
    input: SaveConfigDocumentInput,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let name = if input.name.trim().is_empty() {
        "未命名配置".to_string()
    } else {
        input.name.trim().to_string()
    };
    let sources_json = storage::serialize_sources(&input.sources)?;
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, source_base_url, live_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                name,
                input.raw_config,
                input.normalized_config,
                sources_json,
                input.source_base_url,
                input.live_count
            ],
        )
        .map_err(|error| error.to_string())?;
    let document_id = transaction.last_insert_rowid();

    transaction
        .execute(
            "INSERT INTO app_settings (key, value) VALUES ('active_config_document_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
            params![document_id.to_string()],
        )
        .map_err(|error| error.to_string())?;

    transaction.commit().map_err(|error| error.to_string())?;
    storage::load_config_document(&connection, document_id)?
        .ok_or_else(|| "配置保存后无法读取".to_string())
}

#[tauri::command]
pub fn set_config_source_base_url(
    document_id: i64,
    source_base_url: String,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::set_config_source_base_url(&mut connection, document_id, &source_base_url)
}

#[tauri::command]
pub fn find_config_duplicate(
    raw_config: String,
    source_keys: Vec<String>,
    source_base_url: Option<String>,
    state: State<'_, AppDatabase>,
) -> Result<Option<ConfigDuplicateMatch>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::find_config_duplicate(
        &connection,
        &raw_config,
        &source_keys,
        source_base_url.as_deref(),
    )
}

#[tauri::command]
pub async fn recover_known_live_sources(
    document_id: i64,
    state: State<'_, AppDatabase>,
) -> Result<Option<ConfigDocument>, String> {
    let sources = {
        let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
        storage::load_config_document(&connection, document_id)?
            .ok_or_else(|| "配置不存在或已被删除".to_string())?
            .sources
    };
    let mut replacements = HashMap::new();
    for source in sources {
        let candidates = match source.api.as_str() {
            "./libs/tv/tvlive.txt" => {
                vec!["https://raw.githubusercontent.com/my-tv1/tvv/main/live.txt"]
            }
            "./lib/tv/ipv6.m3u" | "./libs/tv/ipv6.m3u" => vec![
                "https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/ipv6.m3u",
                "https://raw.githubusercontent.com/lsjspl/TV/main/source/ipv6.m3u",
            ],
            "https://raw.githubusercontent.com/my-tv1/tvv/main/live.txt" => {
                vec!["https://iptv-org.github.io/iptv/countries/cn.m3u"]
            }
            _ => Vec::new(),
        };
        for candidate in candidates {
            let url = reqwest::Url::parse(candidate).map_err(|error| error.to_string())?;
            match policy::fetch_text(url, 20 * 1024 * 1024, "公开直播兼容源").await {
                Ok(text) if looks_like_live_source(candidate, &text) => {
                    replacements.insert(source.key.clone(), candidate.to_string());
                    break;
                }
                Ok(_) | Err(_) => continue,
            }
        }
    }
    if replacements.is_empty() {
        return Ok(None);
    }
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::replace_known_live_source_urls(&mut connection, document_id, &replacements)
}

fn looks_like_live_source(url: &str, text: &str) -> bool {
    let lower_url = url.to_ascii_lowercase();
    let trimmed = text.trim_start();
    if lower_url.ends_with(".m3u") || lower_url.ends_with(".m3u8") {
        return trimmed.contains("#EXTINF") || trimmed.starts_with("#EXTM3U");
    }
    text.lines().any(|line| {
        let line = line.trim();
        line.contains("http://") || line.contains("https://")
    })
}

#[tauri::command]
pub fn load_active_config(state: State<'_, AppDatabase>) -> Result<Option<ConfigDocument>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::load_active_document(&connection)
}

#[tauri::command]
pub fn list_config_documents(
    state: State<'_, AppDatabase>,
) -> Result<Vec<ConfigDocumentSummary>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let rows = connection
        .prepare(
            "SELECT id, name, sources_json, live_count, imported_at FROM config_documents ORDER BY id DESC",
        )
        .map_err(|error| error.to_string())?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    rows.into_iter()
        .map(|(id, name, sources_json, live_count, imported_at)| {
            let source_count = match storage::deserialize_sources(sources_json)? {
                Some(sources) => sources.len() as i64,
                None => connection
                    .query_row(
                        "SELECT COUNT(*) FROM sources WHERE document_id = ?1",
                        params![id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| error.to_string())?,
            };
            Ok(ConfigDocumentSummary {
                id,
                name,
                source_count,
                live_count,
                imported_at,
            })
        })
        .collect()
}

#[tauri::command]
pub fn activate_config_document(
    document_id: i64,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let document = storage::load_config_document(&connection, document_id)?
        .ok_or_else(|| "配置不存在或已被删除".to_string())?;
    connection
        .execute(
            "INSERT INTO app_settings (key, value) VALUES ('active_config_document_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
            params![document_id.to_string()],
        )
        .map_err(|error| error.to_string())?;
    Ok(document)
}

#[tauri::command]
pub fn delete_config_document(
    document_id: i64,
    state: State<'_, AppDatabase>,
) -> Result<Option<ConfigDocument>, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let was_active = storage::active_config_id(&connection)? == Some(document_id);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let deleted = transaction
        .execute(
            "DELETE FROM config_documents WHERE id = ?1",
            params![document_id],
        )
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("配置不存在或已被删除".to_string());
    }
    if was_active {
        let next_id = transaction
            .query_row(
                "SELECT id FROM config_documents ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        match next_id {
            Some(next_id) => {
                transaction
                    .execute(
                        "INSERT INTO app_settings (key, value) VALUES ('active_config_document_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
                        params![next_id.to_string()],
                    )
                    .map_err(|error| error.to_string())?;
            }
            None => {
                transaction
                    .execute(
                        "DELETE FROM app_settings WHERE key = 'active_config_document_id'",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    storage::load_active_document(&connection)
}

#[tauri::command]
pub fn set_source_enabled(
    document_id: i64,
    source_key: String,
    enabled: bool,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::set_source_enabled_in_connection(&mut connection, document_id, &source_key, enabled)
}

#[tauri::command]
pub fn remove_sources(
    document_id: i64,
    source_keys: Vec<String>,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::remove_sources_in_connection(&mut connection, document_id, &source_keys)
}

#[tauri::command]
pub fn set_source_script_archive(
    document_id: i64,
    source_key: String,
    archive_id: Option<i64>,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::set_source_script_archive_in_connection(
        &mut connection,
        document_id,
        &source_key,
        archive_id,
    )
}

#[tauri::command]
pub fn update_source_test(
    document_id: i64,
    source_key: String,
    result: cms::SourceTestResult,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::set_source_test_in_connection(&mut connection, document_id, &source_key, &result)
}

#[tauri::command]
pub fn export_config(
    document_id: Option<i64>,
    state: State<'_, AppDatabase>,
) -> Result<String, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let document = match document_id {
        Some(id) => storage::load_config_document(&connection, id)?,
        None => storage::load_active_document(&connection)?,
    }
    .ok_or_else(|| "没有可导出的配置".to_string())?;
    Ok(document.normalized_config)
}

#[tauri::command]
pub async fn fetch_config_url(url: String) -> Result<String, String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    policy::fetch_text(parsed_url, 10 * 1024 * 1024, "配置响应").await
}

/// Replaces every stored configuration with one merged document.
///
/// Moseek keeps a single 中心配置, so the first launch after this became true collapses whatever
/// the user already had into one row. The merging itself happens in TypeScript, next to the parser
/// that produced the documents, because the merge has to agree with the parser about what a source
/// is; this command only performs the swap atomically.
///
/// The old rows are deleted rather than kept: leaving them behind would leave the user looking at
/// configurations that no longer appear anywhere, and the whole point is that there is one.
#[tauri::command]
pub fn replace_all_config_documents(
    input: SaveConfigDocumentInput,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let name = if input.name.trim().is_empty() {
        "中心配置".to_string()
    } else {
        input.name.trim().to_string()
    };
    let sources_json = storage::serialize_sources(&input.sources)?;
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    // `sources` rows reference config_documents with ON DELETE CASCADE, but the table is only
    // written by older versions; deleting explicitly keeps a stale database from keeping orphans.
    transaction
        .execute("DELETE FROM sources", [])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM config_documents", [])
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, source_base_url, live_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                name,
                input.raw_config,
                input.normalized_config,
                sources_json,
                input.source_base_url,
                input.live_count
            ],
        )
        .map_err(|error| error.to_string())?;
    let document_id = transaction.last_insert_rowid();

    transaction
        .execute(
            "INSERT INTO app_settings (key, value) VALUES ('active_config_document_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
            params![document_id.to_string()],
        )
        .map_err(|error| error.to_string())?;

    transaction.commit().map_err(|error| error.to_string())?;
    storage::load_config_document(&connection, document_id)?
        .ok_or_else(|| "中心配置保存后无法读取".to_string())
}
