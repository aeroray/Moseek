mod adapters;
mod cms;
mod config;
mod db;
mod download;
mod html;
mod live;
mod models;
mod page_stream;
mod policy;
mod resolver;
mod script_runtime;
mod script_source;
mod xbpq;

use tauri::Manager;

pub(crate) use models::AppDatabase;
pub use models::{
    ConfigDocument, ConfigDocumentSummary, ConfigDuplicateMatch, SaveConfigDocumentInput,
    SourceOperationResult, SourceRecord,
};

#[tauri::command]
fn healthcheck() -> &'static str {
    "ready"
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let connection =
                db::initialize_database(app.handle()).map_err(std::io::Error::other)?;
            app.manage(AppDatabase(std::sync::Mutex::new(connection)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            healthcheck,
            config::commands::save_config_document,
            config::commands::replace_all_config_documents,
            config::commands::load_active_config,
            config::commands::list_config_documents,
            config::commands::find_config_duplicate,
            config::commands::activate_config_document,
            config::commands::delete_config_document,
            config::commands::set_source_enabled,
            config::commands::remove_sources,
            config::commands::set_source_script_archive,
            config::commands::update_source_test,
            config::commands::export_config,
            config::commands::fetch_config_url,
            config::commands::probe_script_address,
            config::commands::set_config_source_base_url,
            config::commands::recover_known_live_sources,
            cms::browse_source,
            cms::test_source,
            cms::get_detail,
            live::load_live_source,
            live::test_live_source,
            live::get_epg,
            resolver::fetch_media_resource,
            resolver::resolve_playback,
            resolver::probe_stream_urls,
            resolver::sniff_with_companion,
            download::download_image,
            script_runtime::archive::test_script_source,
            script_runtime::archive::list_script_archives,
            script_runtime::archive::list_script_execution_logs,
            script_runtime::archive::save_script_archive,
            script_runtime::archive::set_script_archive_enabled,
            script_runtime::archive::delete_script_archive,
            script_runtime::archive::restore_script_archive,
            script_runtime::archive::purge_script_archive,
            script_runtime::archive::execute_script_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Moseek");
}
