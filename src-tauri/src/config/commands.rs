use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::{
    cms, policy, AppDatabase, ConfigDocument, ConfigDocumentSummary, ConfigDuplicateMatch,
    SaveConfigDocumentInput,
};

use super::{decode, storage};

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

/// Removes every configuration, leaving the database with none.
///
/// **This is the "start over" path, and it deletes the user's imported file.** The interface puts two
/// confirmations in front of it (see `config-center`'s clear dialogs); this command is the single place
/// the deletion is reached, so there is exactly one path to audit.
///
/// The statements themselves live in `storage::clear_all_in_connection`, which is where they can be
/// tested against a real schema — see that function for why the deletion is one transaction.
#[tauri::command]
pub fn clear_all_config_documents(state: State<'_, AppDatabase>) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    storage::clear_all_in_connection(&mut connection)
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

/// Removes sources, off the main thread.
///
/// `async` rather than a plain `fn`, and that is the whole point: a synchronous `#[tauri::command]`
/// runs on the main thread, so the config rewrite blocks the event loop and the window stops
/// responding for its duration. Measured on the owner's 1701-source document, removing 1347 sources
/// took **1979 ms** before the rewrite below was made fast, and the interface was frozen for all of
/// it — which is what the user reported as the button "getting stuck". Tauri runs an `async` command
/// on its async runtime instead, so even a slow rewrite leaves the window able to paint the spinner.
///
/// The work is CPU-bound and touches a `rusqlite` connection, which is neither `Send`-friendly across
/// await points nor acceptable to hold across one, so it is handed to `spawn_blocking` and the
/// blocking section owns the lock for its whole duration.
#[tauri::command]
pub async fn remove_sources(
    document_id: i64,
    source_keys: Vec<String>,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let database = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut connection = database.lock().map_err(|_| "数据库锁定失败".to_string())?;
        storage::remove_sources_in_connection(&mut connection, document_id, &source_keys)
    })
    .await
    .map_err(|error| format!("删除源的任务失败：{error}"))?
}

/// Persists one source's test result, off the main thread.
///
/// `async` + `spawn_blocking` for the same reason as `remove_sources` above, and it is not a
/// theoretical concern here: this rewrites the whole document, which was measured at **4.5 ms on a
/// 320-source document and 10.2 ms on a 700-source one**. That was tolerable while the batch tested
/// four sources at a time, because four results could not arrive closer together than the requests
/// that produced them. The batch now probes **sixteen** at once (`TEST_CONCURRENCY`), so sixteen
/// writes can land in the same instant and serialize on this mutex — a synchronous command would
/// therefore block the event loop for the whole sum, ~160 ms on a large document, once per wave.
///
/// The work is CPU-bound and touches a `rusqlite` connection, which is not `Send`-friendly across
/// await points, so the blocking section owns the lock for its whole duration, exactly as the
/// removal path does.
#[tauri::command]
pub async fn update_source_test(
    document_id: i64,
    source_key: String,
    result: cms::SourceTestResult,
    state: State<'_, AppDatabase>,
) -> Result<ConfigDocument, String> {
    let database = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut connection = database.lock().map_err(|_| "数据库锁定失败".to_string())?;
        storage::set_source_test_in_connection(&mut connection, document_id, &source_key, &result)
    })
    .await
    .map_err(|error| format!("保存测试结果的任务失败：{error}"))?
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

/// Where an exported configuration was written, so the UI can name the file.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedConfig {
    pub path: String,
    pub bytes: usize,
}

/// Writes the configuration wherever the user chooses.
///
/// **The export button did nothing, and this is why.** The frontend built a blob URL and clicked a
/// detached `<a download>`, which is a browser idiom that does not hold up in this webview: the
/// object URL was revoked on the very next line, before the download had read it, and the anchor was
/// never in the document. A download that did begin went to the default folder with no dialog and
/// nothing reported back, so "导出" was indistinguishable from a dead button. The same job is done
/// here the way `download::download_image` already does it — ask, then write — which also means the
/// user picks the location and the app can tell them where the file went.
///
/// `Ok(None)` means the user dismissed the dialog: an ordinary outcome, not an error.
#[tauri::command]
pub async fn export_config_file(
    app: tauri::AppHandle,
    document_id: Option<i64>,
    // The text to write, when the caller has already assembled it. The frontend uses this to fold in
    // the parts of an export that are not configuration (favourites, theme) — it owns those, they
    // live in the webview's storage, and passing the finished text keeps one write path here rather
    // than a second "write these bytes" command with its own dialog.
    text: Option<String>,
    // The name the save dialog opens with, and its title, when the caller is not writing a
    // configuration. 设置 exports the app's own data through this same command — it is the same
    // operation, one dialog and one write, and only the two labels differ.
    file_name: Option<String>,
    title: Option<String>,
    state: State<'_, AppDatabase>,
) -> Result<Option<ExportedConfig>, String> {
    // Read the text and release the lock before awaiting the dialog: the guard is not held across
    // the await, so a slow decision by the user cannot block every other database command.
    let text = match text {
        Some(text) => text,
        None => {
            let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
            let document = match document_id {
                Some(id) => storage::load_config_document(&connection, id)?,
                None => storage::load_active_document(&connection)?,
            }
            .ok_or_else(|| "没有可导出的配置".to_string())?;
            document.normalized_config
        }
    };

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "导出配置".to_string()))
        .set_file_name(file_name.unwrap_or_else(|| EXPORT_FILE_NAME.to_string()))
        .add_filter("JSON 配置", &["json"])
        .save_file(move |path| {
            let _ = sender.send(path);
        });

    let chosen = receiver
        .await
        .map_err(|_| "保存对话框未能返回结果。".to_string())?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path: std::path::PathBuf = chosen
        .into_path()
        .map_err(|error| format!("无法解析所选保存位置：{error}"))?;

    let bytes = text.len();
    std::fs::write(&path, text.as_bytes()).map_err(|error| format!("写入文件失败：{error}"))?;

    Ok(Some(ExportedConfig {
        path: path.to_string_lossy().into_owned(),
        bytes,
    }))
}

/// The name the save dialog opens with.
///
/// `moseek-config.json` rather than the old `moseek-normalized-config.json`: the file is the user's
/// configuration, and "normalized" named an internal detail they never chose.
const EXPORT_FILE_NAME: &str = "moseek-config.json";

/// What the user chose to open, and what was in it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    pub path: String,
    pub text: String,
}

/// The size a file may reach before it is refused, matching `MAX_CONFIG_TEXT_BYTES` in the frontend.
///
/// Kept in step deliberately: a file the dialog opens but the parser then rejects with "超过 10 MiB
/// 限制" would report the same fact twice, in two different words. Refusing at the dialog is the
/// earlier and more useful of the two.
const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;

/// Reads a JSON file the user picks, for importing.
///
/// **The counterpart to `export_config_file`, and it exists for the same reason.** Reading a local file
/// is not something a webview can do: a browser `<input type="file">` would hand the app a `File`
/// object, but the app's own persistence is in Rust and the import path is text in and text out, so a
/// command that returns the text keeps one entry point rather than two. It also means the user sees a
/// native dialog naming the file, which is what makes an import auditable.
///
/// `Ok(None)` means the user dismissed the dialog: an ordinary outcome, not an error.
///
/// The size cap is real rather than theoretical — the dialog can select any file on disk, and reading a
/// multi-gigabyte one into a `String` would fail with an allocation error that names nothing.
#[tauri::command]
pub async fn read_config_file(
    app: tauri::AppHandle,
    title: Option<String>,
) -> Result<Option<ImportedFile>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "导入配置".to_string()))
        .add_filter("JSON 配置", &["json"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });

    let chosen = receiver
        .await
        .map_err(|_| "打开对话框未能返回结果。".to_string())?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path: std::path::PathBuf = chosen
        .into_path()
        .map_err(|error| format!("无法解析所选文件位置：{error}"))?;

    let text = read_config_text(&path)?;

    Ok(Some(ImportedFile {
        path: path.to_string_lossy().into_owned(),
        text,
    }))
}

/// Reads a configuration file from disk as text, bounded and charset-aware.
///
/// Extracted from the command so the behaviour is testable without a native file dialog: the dialog
/// is the only part of `read_config_file` that cannot run in a unit test, and the two defects this
/// function fixes both lived on the far side of it.
///
/// **Two defects lived in the three lines this replaces:**
///
/// 1. `read_to_string` is strict UTF-8, so a GBK or Big5 configuration picked from disk failed with an
///    OS-level "stream did not contain valid UTF-8" — while the same bytes fetched from a URL decoded
///    cleanly through `decode::decode_text`. That module exists precisely because these files are not
///    all UTF-8 ("the file is fine, we merely guessed the wrong encoding"), and the local path is the
///    one a user with a downloaded `.json` actually takes.
/// 2. the size cap was checked on `metadata()` and the file then re-read by path, so anything that
///    grew in between was read anyway. Checking the buffer that was actually read is the only place
///    the cap can be enforced.
fn read_config_text(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("读取文件失败：{error}"))?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(format!(
            "文件过大（{} KB），超过可导入的上限（{} MiB）。",
            bytes.len() / 1024,
            MAX_IMPORT_BYTES / 1024 / 1024
        ));
    }

    // One decoder for both entry points: the URL path already uses this fallback chain, and two
    // import paths that disagree about what a file contains is the bug class this project keeps
    // fixing. The error names the encodings rather than the OS.
    let text = decode::decode_text(&bytes)?;

    Ok(text)
}

/// What fetching a configuration address produced.
///
/// The command used to return the body as a plain `String` and reject anything that was not UTF-8,
/// which reported our encoding guess as the file's fault. It now also has to say WHICH kind of thing
/// came back, because several of these addresses serve a web page or a subscription list rather than
/// a configuration — and "invalid JSON at character 0" is a useless thing to tell someone who pasted
/// a perfectly good address that happens to be a landing page.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedConfig {
    /// The text to show the user, or `None` when the address served only a picture.
    pub text: Option<String>,
    /// `config`, `image-only`, `landing-page` or `multi-repo`. The frontend decides what to offer,
    /// because only it knows what the user can do next.
    pub kind: String,
    /// A sentence naming what had to be unwrapped, or why this is not a configuration.
    pub note: Option<String>,
    /// The title of a landing page, when there is one, so the message can name the page.
    pub page_title: Option<String>,
}

#[tauri::command]
pub async fn fetch_config_url(url: String) -> Result<FetchedConfig, String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    // Raw bytes rather than `fetch_text`: an image wrapper is not text at all, and the decoding has
    // to happen after the container is recognised.
    let (body, _, _) =
        policy::fetch_response_bytes_public(parsed_url, 10 * 1024 * 1024, "配置响应").await?;

    match decode::decode_config_body(&body)? {
        decode::DecodedBody::Text { text, unwrap_note } => Ok(FetchedConfig {
            text: Some(text),
            kind: "config".to_string(),
            note: unwrap_note,
            page_title: None,
        }),
        decode::DecodedBody::ImageOnly { kind, bytes } => Ok(FetchedConfig {
            text: None,
            kind: "image-only".to_string(),
            note: Some(format!(
                "这个地址返回的是一张 {kind} 图片（{bytes} 字节），图片里没有内嵌配置。请确认地址指向的是配置文件。"
            )),
            page_title: None,
        }),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes bytes to a uniquely named temp file and removes it when the guard drops.
    struct TempFile(std::path::PathBuf);

    impl TempFile {
        fn new(extension: &str, bytes: &[u8]) -> Self {
            // Unique per call, so tests running in parallel cannot share a path.
            let unique = format!(
                "moseek-read-config-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or_default()
            );
            let path = std::env::temp_dir().join(format!("{unique}.{extension}"));
            std::fs::write(&path, bytes).expect("write the fixture");
            Self(path)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// Picking a GBK file from disk must decode it, exactly as the URL path does.
    ///
    /// This is the defect the user reported: the same configuration imported cleanly from a URL and
    /// failed from disk with "stream did not contain valid UTF-8", because this path used
    /// `read_to_string` while the fetch path had the encoding fallback.
    #[test]
    fn reads_a_gbk_file_that_utf8_would_reject() {
        let document = "{\"sites\":[{\"key\":\"cctv\",\"name\":\"中央电视台综合频道\"}]}";
        let (encoded, _, had_errors) = encoding_rs::GB18030.encode(document);
        assert!(!had_errors);
        assert!(
            std::str::from_utf8(&encoded).is_err(),
            "the fixture must not be valid UTF-8, or the fallback never runs"
        );
        let file = TempFile::new("json", &encoded);

        let text = read_config_text(file.path()).expect("a GBK file decodes");
        assert!(
            text.contains("中央电视台综合频道"),
            "the name must survive decoding, got: {text}"
        );
    }

    /// A UTF-8 file must be returned byte-for-byte, BOM and all.
    #[test]
    fn reads_a_utf8_file_unchanged() {
        let document = "{\"sites\":[],\"note\":\"中文\"}";
        let file = TempFile::new("json", document.as_bytes());
        assert_eq!(read_config_text(file.path()).unwrap(), document);
    }

    /// An oversized file is refused, and the error names the limit.
    ///
    /// The cap used to be checked against `metadata()` before a second read, which a file could change
    /// between — so the limit was advisory. It is now measured on the bytes actually read.
    #[test]
    fn refuses_a_file_larger_than_the_import_limit() {
        // One byte over the cap, without needing a 10 MiB fixture: the check compares length only.
        let oversized = vec![b' '; (MAX_IMPORT_BYTES + 1) as usize];
        let file = TempFile::new("json", &oversized);

        let error = read_config_text(file.path()).expect_err("an oversized file must be refused");
        assert!(
            error.contains("超过可导入的上限"),
            "the message must name the limit, got: {error}"
        );
    }

    /// A missing file reports a read failure rather than panicking.
    #[test]
    fn reports_a_missing_file_as_an_error() {
        let path = std::env::temp_dir().join("moseek-definitely-not-here-9271.json");
        let error = read_config_text(&path).expect_err("a missing file is an error");
        assert!(error.contains("读取文件失败"), "got: {error}");
    }
}
