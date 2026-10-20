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
               source_base_url TEXT,
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
             );",
        )
        .map_err(|error| error.to_string())
}

pub(crate) fn run(connection: &Connection) -> Result<(), String> {
    ensure_config_source_base_url_column(connection)?;
    ensure_config_sources_column(connection)?;
    ensure_sources_epg_column(connection)?;
    drop_script_archive_tables(connection)
}

/// Removes the two tables that backed 本地脚本档案.
///
/// The feature is gone: it existed to run CatVod JS sources from a manually imported `.js` file, it
/// was never used (both tables measured empty), and nothing reads them now. Leaving them behind would
/// keep a schema that describes a capability the app does not have — the next person to read
/// `migrations.rs` would find tables with no writer and have to work out why.
///
/// Dropped rather than merely no longer created, because `CREATE TABLE IF NOT EXISTS` is exactly what
/// would leave them in place on every existing install. `script_archives` goes first: it is the table
/// `script_execution_logs.archive_id` referred to, and dropping a referenced table first keeps the
/// intent readable even though SQLite does not enforce it here.
///
/// The cookies those archives could store lived in the Windows credential store, keyed by archive id
/// (`com.moseek.desktop` / `script-archive-<id>`). A user who imported an archive and gave it a
/// cookie would leave that entry behind; it is unreachable now that nothing looks it up. Enumerating
/// and deleting it would need the archive ids, which is the table being dropped — so the entries are
/// left rather than guessed at, and they hold nothing the app can use.
fn drop_script_archive_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "DROP TABLE IF EXISTS script_execution_logs;
             DROP TABLE IF EXISTS script_archives;",
        )
        .map_err(|error| error.to_string())
}

fn ensure_config_source_base_url_column(connection: &Connection) -> Result<(), String> {
    add_column_if_missing(connection, "config_documents", "source_base_url", "TEXT")
}

fn has_column(connection: &Connection, table: &'static str, column: &'static str) -> Result<bool, String> {
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

/// Adds a column when the table does not already have it.
///
/// **Every argument must be a literal from this file.** The DDL is assembled with `format!` because
/// SQLite has no parameter form for identifiers, so `table`, `column` and `definition` cannot be
/// bound — they are interpolated. That is safe only because every call site passes a `&'static str`
/// written here; a value derived from imported configuration would be SQL injection, and this
/// function cannot tell the difference. If a dynamic name is ever needed, replace this with a match
/// over a fixed set of identifiers rather than passing the string through.
fn add_column_if_missing(
    connection: &Connection,
    table: &'static str,
    column: &'static str,
    definition: &'static str,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn table_exists(connection: &Connection, name: &str) -> bool {
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [name],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count > 0)
            .unwrap_or(false)
    }

    /// A fresh database must not contain the tables that back the removed 本地脚本档案 feature.
    ///
    /// This was a create-then-drop every launch: `create_tables` still issued
    /// `CREATE TABLE IF NOT EXISTS script_execution_logs` and `run` dropped it immediately after, so
    /// the schema described a capability the app does not have and every start did pointless work.
    /// The drop stays (existing installs still hold the table); the creation is what had to go.
    #[test]
    fn a_fresh_database_never_creates_the_removed_archive_tables() {
        let connection = Connection::open_in_memory().unwrap();
        create_tables(&connection).unwrap();
        run(&connection).unwrap();

        assert!(
            !table_exists(&connection, "script_execution_logs"),
            "the execution-log table backs a removed feature and must not be created"
        );
        assert!(
            !table_exists(&connection, "script_archives"),
            "the archive table backs a removed feature and must not be created"
        );
        // The tables the app actually uses must survive the same pass.
        assert!(table_exists(&connection, "config_documents"));
        assert!(table_exists(&connection, "app_settings"));
    }

    /// Upgrading an old install must still drop the tables, even though nothing creates them now.
    ///
    /// The `DROP TABLE IF EXISTS` in `run` is the only thing that removes them from a database written
    /// by an earlier version, so removing the create without keeping the drop would leave the dead
    /// schema on every existing machine.
    #[test]
    fn an_existing_database_still_has_the_archive_tables_removed() {
        let connection = Connection::open_in_memory().unwrap();
        create_tables(&connection).unwrap();
        // Simulate the schema an older build left behind.
        connection
            .execute_batch(
                "CREATE TABLE script_execution_logs (id INTEGER PRIMARY KEY, entry TEXT);
                 CREATE TABLE script_archives (id INTEGER PRIMARY KEY, name TEXT);",
            )
            .unwrap();

        run(&connection).unwrap();

        assert!(!table_exists(&connection, "script_execution_logs"));
        assert!(!table_exists(&connection, "script_archives"));
    }

    /// Running the migrations twice must be a no-op, not an error.
    ///
    /// `add_column_if_missing` guards on `has_column`, and this pins that: a migration that threw on
    /// the second start would make the app fail to open after it had already worked once.
    #[test]
    fn running_migrations_twice_is_harmless() {
        let connection = Connection::open_in_memory().unwrap();
        create_tables(&connection).unwrap();
        run(&connection).unwrap();
        run(&connection).expect("a second run must not fail");
    }
}
