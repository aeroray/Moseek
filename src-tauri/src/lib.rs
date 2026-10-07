mod adapters;
mod cms;
mod config;
mod db;
mod download;
mod html;
mod live;
mod media_requests;
mod models;
mod page_stream;
mod policy;
mod resolver;
mod test_runs;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let connection =
                db::initialize_database(app.handle()).map_err(std::io::Error::other)?;
            app.manage(AppDatabase(std::sync::Arc::new(std::sync::Mutex::new(
                connection,
            ))));
            app.manage(resolver::MediaStreamRegistry::default());
            app.manage(test_runs::TestRunRegistry::default());
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
            config::commands::update_source_test,
            config::commands::export_config,
            config::commands::export_config_file,
            config::commands::fetch_config_url,
            config::commands::set_config_source_base_url,
            config::commands::recover_known_live_sources,
            cms::browse_source,
            cms::test_source,
            test_runs::cancel_source_test,
            test_runs::forget_source_test_run,
            cms::get_detail,
            live::load_live_source,
            live::test_live_source,
            live::get_epg,
            resolver::fetch_media_resource,
            resolver::probe_media_container,
            resolver::stream_media_resource,
            resolver::cancel_media_stream,
            resolver::resolve_playback,
            resolver::probe_stream_urls,
            resolver::sniff_with_companion,
            download::download_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Moseek");
}
