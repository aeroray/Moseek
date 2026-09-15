mod migrations;

use std::fs;

use rusqlite::Connection;
use tauri::Manager;

pub(crate) fn initialize_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    let database_path = data_directory.join("moseek.sqlite3");
    let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    migrations::create_tables(&connection)?;
    migrations::run(&connection)?;
    Ok(connection)
}
