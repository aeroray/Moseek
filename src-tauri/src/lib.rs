use std::{
    collections::{HashMap, HashSet},
    fs,
    sync::Mutex,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, State};

mod adapters;
mod cms;
mod html;
mod live;
mod policy;
mod resolver;
mod script_runtime;

struct AppDatabase(Mutex<Connection>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub key: String,
    pub name: String,
    pub source_type: String,
    #[serde(default)]
    pub script_archive_id: Option<i64>,
    #[serde(default)]
    pub source_dialect: Option<String>,
    pub site_type: Option<i64>,
    pub site_protocol: Option<String>,
    pub api: String,
    #[serde(default)]
    pub logo: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub nsfw: bool,
    #[serde(default = "default_true")]
    pub status: bool,
    pub ext: Option<String>,
    #[serde(default)]
    pub extra: Option<String>,
    pub jar: Option<String>,
    pub epg: Option<String>,
    pub searchable: bool,
    pub filterable: bool,
    pub capability: String,
    pub capability_note: String,
    #[serde(default)]
    pub test_status: Option<String>,
    #[serde(default)]
    pub test_message: Option<String>,
    #[serde(default)]
    pub tested_at: Option<String>,
    #[serde(default)]
    pub test_item_count: Option<u64>,
    #[serde(default)]
    pub test_category_count: Option<u64>,
    #[serde(default)]
    pub test_duration_ms: Option<u64>,
    #[serde(default)]
    pub test_operations: Vec<SourceOperationResult>,
    pub enabled: bool,
    pub last_checked_at: String,
    pub request_count: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOperationResult {
    pub operation: String,
    pub status: String,
    pub message: String,
    pub duration_ms: u64,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConfigDocumentInput {
    pub name: String,
    pub raw_config: String,
    pub normalized_config: String,
    pub sources: Vec<SourceRecord>,
    pub live_count: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocumentSummary {
    pub id: i64,
    pub name: String,
    pub source_count: i64,
    pub live_count: i64,
    pub imported_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub id: i64,
    pub name: String,
    pub raw_config: String,
    pub normalized_config: String,
    pub sources: Vec<SourceRecord>,
    pub source_count: i64,
    pub live_count: i64,
    pub imported_at: String,
}

#[tauri::command]
fn healthcheck() -> &'static str {
    "ready"
}

fn serialize_sources(sources: &[SourceRecord]) -> Result<String, String> {
    serde_json::to_string(sources).map_err(|error| format!("配置源快照序列化失败：{error}"))
}

fn deserialize_sources(value: Option<String>) -> Result<Option<Vec<SourceRecord>>, String> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    serde_json::from_str(&value)
        .map(Some)
        .map_err(|error| format!("配置源快照解析失败：{error}"))
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

fn load_config_document(
    connection: &Connection,
    document_id: i64,
) -> Result<Option<ConfigDocument>, String> {
    let document = connection
        .query_row(
            "SELECT id, name, raw_config, normalized_config, sources_json, live_count, imported_at FROM config_documents WHERE id = ?1",
            params![document_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((id, name, raw_config, normalized_config, sources_json, live_count, imported_at)) =
        document
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
    }))
}

fn load_latest_document(connection: &Connection) -> Result<Option<ConfigDocument>, String> {
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

fn active_config_id(connection: &Connection) -> Result<Option<i64>, String> {
    let value = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'active_config_document_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(value.and_then(|value| value.parse::<i64>().ok()))
}

fn load_active_document(connection: &Connection) -> Result<Option<ConfigDocument>, String> {
    if let Some(document_id) = active_config_id(connection)? {
        if let Some(document) = load_config_document(connection, document_id)? {
            return Ok(Some(document));
        }
    }
    load_latest_document(connection)
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
            }
        }
    }
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| normalized_config.to_string())
}

fn set_source_enabled_in_connection(
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

fn set_source_script_archive_in_connection(
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

fn set_source_test_in_connection(
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
        .ok_or_else(|| "测试结果保存后无法读取".to_string())
}

#[tauri::command]
fn save_config_document(
    input: SaveConfigDocumentInput,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let name = if input.name.trim().is_empty() {
        "未命名配置".to_string()
    } else {
        input.name.trim().to_string()
    };
    let sources_json = serialize_sources(&input.sources)?;
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            "INSERT INTO config_documents (name, raw_config, normalized_config, sources_json, live_count) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                name,
                input.raw_config,
                input.normalized_config,
                sources_json,
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
    load_config_document(&connection, document_id)?.ok_or_else(|| "配置保存后无法读取".to_string())
}

#[tauri::command]
fn load_latest_config(state: State<'_, AppDatabase>) -> Result<Option<ConfigDocument>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    load_latest_document(&connection)
}

#[tauri::command]
fn load_active_config(state: State<'_, AppDatabase>) -> Result<Option<ConfigDocument>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    load_active_document(&connection)
}

#[tauri::command]
fn list_config_documents(
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
            let source_count = match deserialize_sources(sources_json)? {
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
fn activate_config_document(
    document_id: i64,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let document = load_config_document(&connection, document_id)?
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
fn delete_config_document(
    document_id: i64,
    state: State<'_, AppDatabase>,
) -> Result<Option<ConfigDocument>, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let was_active = active_config_id(&connection)? == Some(document_id);
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
    load_active_document(&connection)
}

#[tauri::command]
fn set_source_enabled(
    document_id: i64,
    source_key: String,
    enabled: bool,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    set_source_enabled_in_connection(&mut connection, document_id, &source_key, enabled)
}

#[tauri::command]
fn set_source_script_archive(
    document_id: i64,
    source_key: String,
    archive_id: Option<i64>,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    set_source_script_archive_in_connection(&mut connection, document_id, &source_key, archive_id)
}

#[tauri::command]
fn update_source_test(
    document_id: i64,
    source_key: String,
    result: cms::SourceTestResult,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    set_source_test_in_connection(&mut connection, document_id, &source_key, &result)
}

#[tauri::command]
fn export_config(
    document_id: Option<i64>,
    state: State<'_, AppDatabase>,
) -> Result<String, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let document = match document_id {
        Some(id) => load_config_document(&connection, id)?,
        None => load_active_document(&connection)?,
    }
    .ok_or_else(|| "没有可导出的配置".to_string())?;
    Ok(document.normalized_config)
}

#[tauri::command]
async fn fetch_config_url(url: String) -> Result<String, String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    policy::fetch_text(parsed_url, 10 * 1024 * 1024, "配置响应").await
}

fn initialize_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    let database_path = data_directory.join("moseek.sqlite3");
    let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS config_documents (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               raw_config TEXT NOT NULL,
               normalized_config TEXT NOT NULL,
                             sources_json TEXT,
               live_count INTEGER NOT NULL DEFAULT 0,
               imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS sources (
               source_key TEXT PRIMARY KEY,
               document_id INTEGER NOT NULL REFERENCES config_documents(id) ON DELETE CASCADE,
               name TEXT NOT NULL,
               source_type TEXT NOT NULL,
               api TEXT NOT NULL,
               ext TEXT,
               jar TEXT,
               epg TEXT,
               searchable INTEGER NOT NULL DEFAULT 0,
               filterable INTEGER NOT NULL DEFAULT 0,
               capability TEXT NOT NULL,
               capability_note TEXT NOT NULL,
               enabled INTEGER NOT NULL DEFAULT 0,
               last_checked_at TEXT NOT NULL,
               request_count INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS source_capabilities (
               source_key TEXT PRIMARY KEY REFERENCES sources(source_key) ON DELETE CASCADE,
               capability TEXT NOT NULL,
               reason TEXT NOT NULL,
               checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS source_categories (
               source_key TEXT NOT NULL REFERENCES sources(source_key) ON DELETE CASCADE,
               category_id TEXT NOT NULL,
               category_name TEXT NOT NULL,
               PRIMARY KEY (source_key, category_id)
             );
             CREATE TABLE IF NOT EXISTS live_sources (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               source_url TEXT NOT NULL,
               format TEXT NOT NULL,
               enabled INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS live_channels (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               live_source_id INTEGER NOT NULL REFERENCES live_sources(id) ON DELETE CASCADE,
               name TEXT NOT NULL,
               group_name TEXT,
               logo_url TEXT,
               stream_url TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS parse_services (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               service_url TEXT NOT NULL,
               capability TEXT NOT NULL,
               enabled INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS play_history (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               source_key TEXT,
               vod_id TEXT NOT NULL,
               title TEXT NOT NULL,
               episode TEXT,
               position_seconds INTEGER NOT NULL DEFAULT 0,
               duration_seconds INTEGER NOT NULL DEFAULT 0,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS favorites (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               item_type TEXT NOT NULL,
               item_id TEXT NOT NULL,
               title TEXT NOT NULL,
               payload TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               UNIQUE (item_type, item_id)
             );
             CREATE TABLE IF NOT EXISTS request_logs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               source_key TEXT,
               method TEXT NOT NULL,
               url TEXT NOT NULL,
               status_code INTEGER,
               duration_ms INTEGER,
               error_kind TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS app_settings (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                         );
                         CREATE TABLE IF NOT EXISTS script_archives (
                             id INTEGER PRIMARY KEY AUTOINCREMENT,
                             name TEXT NOT NULL,
                             file_name TEXT NOT NULL,
                             sha256 TEXT NOT NULL UNIQUE,
                             script TEXT NOT NULL,
                             entry TEXT NOT NULL DEFAULT 'main',
                             http_hosts_json TEXT NOT NULL DEFAULT '[]',
                               http_headers_json TEXT NOT NULL DEFAULT '{}',
                               cookie_present INTEGER NOT NULL DEFAULT 0,
                             enabled INTEGER NOT NULL DEFAULT 0,
                             imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                             last_used_at TEXT,
                             deleted_at TEXT
             );",
        )
        .map_err(|error| error.to_string())?;
    ensure_config_sources_column(&connection)?;
    ensure_sources_epg_column(&connection)?;
    ensure_script_archives_deleted_at_column(&connection)?;
    ensure_script_archives_http_headers_column(&connection)?;
    ensure_script_archives_cookie_column(&connection)?;
    script_runtime::migrate_script_archive_cookies(&connection)?;
    Ok(connection)
}

fn ensure_config_sources_column(connection: &Connection) -> Result<(), String> {
    let has_sources_json = connection
        .prepare("PRAGMA table_info(config_documents)")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .iter()
        .any(|column| column == "sources_json");
    if !has_sources_json {
        connection
            .execute(
                "ALTER TABLE config_documents ADD COLUMN sources_json TEXT",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_sources_epg_column(connection: &Connection) -> Result<(), String> {
    let has_epg = connection
        .prepare("PRAGMA table_info(sources)")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .iter()
        .any(|column| column == "epg");
    if !has_epg {
        connection
            .execute("ALTER TABLE sources ADD COLUMN epg TEXT", [])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_script_archives_deleted_at_column(connection: &Connection) -> Result<(), String> {
    let has_deleted_at = connection
        .prepare("PRAGMA table_info(script_archives)")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .iter()
        .any(|column| column == "deleted_at");
    if !has_deleted_at {
        connection
            .execute("ALTER TABLE script_archives ADD COLUMN deleted_at TEXT", [])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_script_archives_http_headers_column(connection: &Connection) -> Result<(), String> {
    let has_http_headers = connection
        .prepare("PRAGMA table_info(script_archives)")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .iter()
        .any(|column| column == "http_headers_json");
    if !has_http_headers {
        connection
            .execute(
                "ALTER TABLE script_archives ADD COLUMN http_headers_json TEXT NOT NULL DEFAULT '{}'",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_script_archives_cookie_column(connection: &Connection) -> Result<(), String> {
    let has_cookie = connection
        .prepare("PRAGMA table_info(script_archives)")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .iter()
        .any(|column| column == "cookie_present");
    if !has_cookie {
        connection
            .execute(
                "ALTER TABLE script_archives ADD COLUMN cookie_present INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let connection =
                initialize_database(app.handle()).map_err(|error| std::io::Error::other(error))?;
            app.manage(AppDatabase(Mutex::new(connection)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            healthcheck,
            save_config_document,
            load_latest_config,
            load_active_config,
            list_config_documents,
            activate_config_document,
            delete_config_document,
            set_source_enabled,
            set_source_script_archive,
            update_source_test,
            export_config,
            fetch_config_url,
            cms::browse_source,
            cms::test_source,
            cms::get_detail,
            live::load_live_source,
            live::test_live_source,
            live::get_epg,
            resolver::resolve_playback,
            resolver::sniff_with_companion,
            script_runtime::execute_script,
            script_runtime::test_script_source,
            script_runtime::list_script_archives,
            script_runtime::save_script_archive,
            script_runtime::set_script_archive_enabled,
            script_runtime::delete_script_archive,
            script_runtime::restore_script_archive,
            script_runtime::execute_script_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Moseek");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_schema(connection: &Connection) {
        connection
            .execute_batch(
                "CREATE TABLE config_documents (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT NOT NULL,
                   raw_config TEXT NOT NULL,
                   normalized_config TEXT NOT NULL,
                   sources_json TEXT,
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

    fn insert_test_document(connection: &Connection, name: &str, enabled: bool) -> i64 {
        let sources_json = serialize_sources(&[test_source(enabled)]).unwrap();
        let normalized_config = serde_json::json!({
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
        let normalized_config = serde_json::json!({
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
}
