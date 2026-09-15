use rusqlite::{params, OptionalExtension};
use tauri::State;

use crate::{
    cms, policy, AppDatabase, ConfigDocument, ConfigDocumentSummary, SaveConfigDocumentInput,
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
    storage::load_config_document(&connection, document_id)?
        .ok_or_else(|| "配置保存后无法读取".to_string())
}

#[tauri::command]
pub fn load_latest_config(state: State<'_, AppDatabase>) -> Result<Option<ConfigDocument>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::load_latest_document(&connection)
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
