use std::{
    fs,
    net::{IpAddr, ToSocketAddrs},
    sync::Mutex,
    time::Duration,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

mod cms;

struct AppDatabase(Mutex<Connection>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub key: String,
    pub name: String,
    pub source_type: String,
    pub api: String,
    pub ext: Option<String>,
    pub jar: Option<String>,
    pub searchable: bool,
    pub filterable: bool,
    pub capability: String,
    pub capability_note: String,
    pub enabled: bool,
    pub last_checked_at: String,
    pub request_count: i64,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub id: i64,
    pub name: String,
    pub raw_config: String,
    pub normalized_config: String,
    pub sources: Vec<SourceRecord>,
    pub live_count: i64,
    pub imported_at: String,
}

#[tauri::command]
fn healthcheck() -> &'static str {
    "ready"
}

#[tauri::command]
fn save_config_document(
    input: SaveConfigDocumentInput,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let mut connection = state
        .0
        .lock()
        .map_err(|_| "数据库锁定失败".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            "INSERT INTO config_documents (name, raw_config, normalized_config, live_count) VALUES (?1, ?2, ?3, ?4)",
            params![input.name, input.raw_config, input.normalized_config, input.live_count],
        )
        .map_err(|error| error.to_string())?;
    let document_id = transaction.last_insert_rowid();

    for source in &input.sources {
        transaction
            .execute(
                "INSERT OR REPLACE INTO sources (source_key, document_id, name, source_type, api, ext, jar, searchable, filterable, capability, capability_note, enabled, last_checked_at, request_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    source.key,
                    document_id,
                    source.name,
                    source.source_type,
                    source.api,
                    source.ext,
                    source.jar,
                    i64::from(source.searchable),
                    i64::from(source.filterable),
                    source.capability,
                    source.capability_note,
                    i64::from(source.enabled),
                    source.last_checked_at,
                    source.request_count,
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())?;
    let imported_at = connection
        .query_row(
            "SELECT imported_at FROM config_documents WHERE id = ?1",
            params![document_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    Ok(ConfigDocument {
        id: document_id,
        name: input.name,
        raw_config: input.raw_config,
        normalized_config: input.normalized_config,
        sources: input.sources,
        live_count: input.live_count,
        imported_at,
    })
}

#[tauri::command]
fn load_latest_config(state: State<'_, AppDatabase>) -> Result<Option<ConfigDocument>, String> {
    let connection = state
        .0
        .lock()
        .map_err(|_| "数据库锁定失败".to_string())?;
    let document = connection
        .query_row(
            "SELECT id, name, raw_config, normalized_config, live_count, imported_at FROM config_documents ORDER BY id DESC LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((id, name, raw_config, normalized_config, live_count, imported_at)) = document else {
        return Ok(None);
    };

    let mut statement = connection
        .prepare("SELECT source_key, name, source_type, api, ext, jar, searchable, filterable, capability, capability_note, enabled, last_checked_at, request_count FROM sources WHERE document_id = ?1 ORDER BY rowid")
        .map_err(|error| error.to_string())?;
    let sources = statement
        .query_map(params![id], |row| {
            Ok(SourceRecord {
                key: row.get(0)?,
                name: row.get(1)?,
                source_type: row.get(2)?,
                api: row.get(3)?,
                ext: row.get(4)?,
                jar: row.get(5)?,
                searchable: row.get::<_, i64>(6)? != 0,
                filterable: row.get::<_, i64>(7)? != 0,
                capability: row.get(8)?,
                capability_note: row.get(9)?,
                enabled: row.get::<_, i64>(10)? != 0,
                last_checked_at: row.get(11)?,
                request_count: row.get(12)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(Some(ConfigDocument {
        id,
        name,
        raw_config,
        normalized_config,
        sources,
        live_count,
        imported_at,
    }))
}

#[tauri::command]
fn set_source_enabled(
    source_key: String,
    enabled: bool,
    state: State<'_, AppDatabase>,
) -> Result<(), String> {
    let connection = state
        .0
        .lock()
        .map_err(|_| "数据库锁定失败".to_string())?;
    connection
        .execute(
            "UPDATE sources SET enabled = ?1 WHERE source_key = ?2",
            params![i64::from(enabled), source_key],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn export_config(
    document_id: Option<i64>,
    state: State<'_, AppDatabase>,
) -> Result<String, String> {
    let connection = state
        .0
        .lock()
        .map_err(|_| "数据库锁定失败".to_string())?;
    match document_id {
        Some(id) => connection
            .query_row(
                "SELECT normalized_config FROM config_documents WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string()),
        None => connection
            .query_row(
                "SELECT normalized_config FROM config_documents ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string()),
    }
}

#[tauri::command]
async fn fetch_config_url(url: String) -> Result<String, String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    validate_remote_url(&parsed_url)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Moseek/0.1")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(parsed_url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    if response.content_length().unwrap_or(0) > 10 * 1024 * 1024 {
        return Err("配置响应超过 10 MB 限制".to_string());
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?;
    if body.len() > 10 * 1024 * 1024 {
        return Err("配置响应超过 10 MB 限制".to_string());
    }
    String::from_utf8(body.to_vec()).map_err(|_| "配置响应不是有效的 UTF-8 文本".to_string())
}

fn is_disallowed_host(host: &str) -> bool {
    let normalized_host = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized_host == "localhost"
        || normalized_host.ends_with(".localhost")
        || normalized_host.ends_with(".local")
    {
        return true;
    }
    match normalized_host.parse::<IpAddr>() {
        Ok(address) => is_disallowed_ip(address),
        Err(_) => false,
    }
}

pub(crate) fn validate_remote_url(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只允许 HTTP 或 HTTPS 地址".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "地址缺少主机名".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    if is_disallowed_host(host) || resolves_to_disallowed_address(host, port) {
        return Err("本机和局域网地址默认未授权，请在设置中主动开启".to_string());
    }
    Ok(())
}

fn resolves_to_disallowed_address(host: &str, port: u16) -> bool {
    match (host, port).to_socket_addrs() {
        Ok(mut addresses) => addresses.any(|address| is_disallowed_ip(address.ip())),
        Err(_) => false,
    }
}

fn is_disallowed_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || (address.segments()[0] & 0xfe00 == 0xfc00)
        }
    }
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
             );",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let connection = initialize_database(app.handle())
                .map_err(|error| std::io::Error::other(error))?;
            app.manage(AppDatabase(Mutex::new(connection)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            healthcheck,
            save_config_document,
            load_latest_config,
            set_source_enabled,
            export_config,
            fetch_config_url,
            cms::search_source,
            cms::get_source_detail
        ])
        .run(tauri::generate_context!())
        .expect("error while running Moseek");
}
