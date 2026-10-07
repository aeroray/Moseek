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
        .set_title("导出配置")
        .set_file_name(EXPORT_FILE_NAME)
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
