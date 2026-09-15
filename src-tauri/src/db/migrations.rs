use rusqlite::Connection;

pub(crate) fn create_tables(connection: &Connection) -> Result<(), String> {
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
             CREATE TABLE IF NOT EXISTS script_execution_logs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               archive_id INTEGER,
               entry TEXT NOT NULL,
               status TEXT NOT NULL,
               phase TEXT NOT NULL,
               duration_ms INTEGER NOT NULL,
               http_call_count INTEGER NOT NULL DEFAULT 0,
               http_hosts_json TEXT NOT NULL DEFAULT '[]',
               http_calls_json TEXT NOT NULL DEFAULT '[]',
               error_kind TEXT,
               timed_out INTEGER NOT NULL DEFAULT 0,
               credential_lookup_failed INTEGER NOT NULL DEFAULT 0,
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
               modules_json TEXT NOT NULL DEFAULT '{}',
               cookie_present INTEGER NOT NULL DEFAULT 0,
               enabled INTEGER NOT NULL DEFAULT 0,
               imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               last_used_at TEXT,
               deleted_at TEXT
             );",
        )
        .map_err(|error| error.to_string())
}

pub(crate) fn run(connection: &Connection) -> Result<(), String> {
    ensure_config_sources_column(connection)?;
    ensure_sources_epg_column(connection)?;
    ensure_script_archives_deleted_at_column(connection)?;
    ensure_script_archives_http_headers_column(connection)?;
    ensure_script_archives_modules_column(connection)?;
    ensure_script_archives_cookie_column(connection)?;
    crate::script_runtime::archive::migrate_script_archive_cookies(connection)
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map(|columns| columns.iter().any(|value| value == column))
        .map_err(|error| error.to_string());
    columns
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    if !has_column(connection, table, column)? {
        connection
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_config_sources_column(connection: &Connection) -> Result<(), String> {
    add_column_if_missing(connection, "config_documents", "sources_json", "TEXT")
}

fn ensure_sources_epg_column(connection: &Connection) -> Result<(), String> {
    add_column_if_missing(connection, "sources", "epg", "TEXT")
}

fn ensure_script_archives_deleted_at_column(connection: &Connection) -> Result<(), String> {
    add_column_if_missing(connection, "script_archives", "deleted_at", "TEXT")
}

fn ensure_script_archives_http_headers_column(connection: &Connection) -> Result<(), String> {
    add_column_if_missing(
        connection,
        "script_archives",
        "http_headers_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )
}

fn ensure_script_archives_modules_column(connection: &Connection) -> Result<(), String> {
    add_column_if_missing(
        connection,
        "script_archives",
        "modules_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )
}

fn ensure_script_archives_cookie_column(connection: &Connection) -> Result<(), String> {
    add_column_if_missing(
        connection,
        "script_archives",
        "cookie_present",
        "INTEGER NOT NULL DEFAULT 0",
    )
}
