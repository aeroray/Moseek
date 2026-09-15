use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri::State;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::time::timeout;

use crate::policy::{fetch_text_with_headers, validate_remote_url};
use crate::{AppDatabase, SourceOperationResult, SourceRecord};

const MAX_SCRIPT_EXECUTION_TIME: Duration = Duration::from_secs(20);
const MAX_HOST_CALL_TIME: Duration = Duration::from_secs(16);
const MAX_ARCHIVE_SCRIPT_BYTES: usize = 512 * 1024;
const KEYRING_SERVICE: &str = "com.moseek.desktop";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptExecutionRequest {
    pub script: String,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub http_hosts: Vec<String>,
    #[serde(default)]
    pub http_headers: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptExecutionResult {
    pub value: Value,
    pub adapter_id: String,
    pub http_call_count: u32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveScriptArchiveInput {
    pub name: String,
    pub file_name: String,
    pub script: String,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub http_hosts: Vec<String>,
    #[serde(default)]
    pub http_headers: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptArchiveSummary {
    pub id: i64,
    pub name: String,
    pub file_name: String,
    pub sha256: String,
    pub entry: String,
    pub http_hosts: Vec<String>,
    pub http_header_names: Vec<String>,
    pub has_cookie: bool,
    pub enabled: bool,
    pub imported_at: String,
    pub last_used_at: Option<String>,
}

struct StoredScriptArchive {
    summary: ScriptArchiveSummary,
    script: String,
    http_headers: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostCall {
    kind: String,
    id: u64,
    method: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostResponse {
    kind: &'static str,
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RuntimeResponse {
    ok: bool,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

#[tauri::command]
pub async fn execute_script(
    app: AppHandle,
    request: ScriptExecutionRequest,
) -> Result<ScriptExecutionResult, String> {
    run_script(app, request).await
}

async fn run_script(
    app: AppHandle,
    request: ScriptExecutionRequest,
) -> Result<ScriptExecutionResult, String> {
    if request.script.trim().is_empty() {
        return Err("脚本内容不能为空".to_string());
    }
    let allowed_hosts = normalize_hosts(&request.http_hosts);
    let http_headers = normalize_http_headers(&request.http_headers)?;
    let mut request = request;
    request.http_headers = http_headers.clone();
    let request_json = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let sidecar = app
        .shell()
        .sidecar("moseek-script-runtime")
        .map_err(|error| format!("找不到脚本运行时 sidecar：{error}"))?;
    let (mut events, mut child) = sidecar
        .spawn()
        .map_err(|error| format!("启动脚本运行时失败：{error}"))?;
    child
        .write(format!("{request_json}\n").as_bytes())
        .map_err(|error| format!("发送脚本运行请求失败：{error}"))?;

    let mut stdout_buffer = String::new();
    let mut http_call_count = 0;
    let mut final_result: Option<Result<Value, String>> = None;
    let deadline = Instant::now() + MAX_SCRIPT_EXECUTION_TIME;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            final_result = Some(Err("脚本 sidecar 执行超过 20 秒限制".to_string()));
            break;
        }
        let event = match timeout(remaining, events.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => {
                final_result = Some(Err("脚本运行时提前退出".to_string()));
                break;
            }
            Err(_) => {
                final_result = Some(Err("脚本 sidecar 执行超过 20 秒限制".to_string()));
                break;
            }
        };
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout_buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(line) = take_line(&mut stdout_buffer) {
                    let value: Value = serde_json::from_str(&line)
                        .map_err(|error| format!("脚本运行时返回了无效 JSON：{error}"))?;
                    if value.get("kind").and_then(Value::as_str) == Some("host_call") {
                        let call: HostCall = serde_json::from_value(value)
                            .map_err(|error| format!("host-call 格式无效：{error}"))?;
                        let response = match timeout(
                            MAX_HOST_CALL_TIME
                                .min(deadline.saturating_duration_since(Instant::now())),
                            handle_host_call(&call, &allowed_hosts, &http_headers),
                        )
                        .await
                        {
                            Ok(response) => response,
                            Err(_) => host_error(call.id, "脚本 HTTP 请求超过 16 秒限制"),
                        };
                        if call.method == "http_get" {
                            http_call_count += 1;
                        }
                        child
                            .write(
                                format!(
                                    "{}\n",
                                    serde_json::to_string(&response)
                                        .map_err(|error| error.to_string())?
                                )
                                .as_bytes(),
                            )
                            .map_err(|error| format!("返回 host-call 结果失败：{error}"))?;
                    } else if value.get("ok").is_some() {
                        let response: RuntimeResponse = serde_json::from_value(value)
                            .map_err(|error| format!("脚本运行结果格式无效：{error}"))?;
                        final_result = Some(if response.ok {
                            Ok(response.value.unwrap_or(Value::Null))
                        } else {
                            Err(response.error.unwrap_or_else(|| "脚本执行失败".to_string()))
                        });
                        break;
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let message = String::from_utf8_lossy(&bytes).trim().to_string();
                if !message.is_empty() {
                    final_result = Some(Err(format!("脚本运行时错误：{message}")));
                    break;
                }
            }
            CommandEvent::Error(error) => {
                final_result = Some(Err(format!("脚本运行时错误：{error}")));
                break;
            }
            CommandEvent::Terminated(payload) => {
                final_result = Some(Err(format!("脚本运行时退出：{payload:?}")));
                break;
            }
            _ => {}
        }
        if final_result.is_some() {
            break;
        }
    }
    let result = final_result.unwrap_or_else(|| Err("脚本运行时没有返回结果".to_string()));
    let _ = child.kill();
    Ok(ScriptExecutionResult {
        value: result?,
        adapter_id: "quickjs-sidecar".to_string(),
        http_call_count,
    })
}

#[tauri::command]
pub fn list_script_archives(
    state: State<'_, AppDatabase>,
) -> Result<Vec<ScriptArchiveSummary>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let rows = connection
        .prepare(
            "SELECT id, name, file_name, sha256, entry, http_hosts_json, http_headers_json, cookie_present, enabled, imported_at, last_used_at FROM script_archives WHERE deleted_at IS NULL ORDER BY id DESC",
        )
        .map_err(|error| error.to_string())?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, bool>(7)?,
                row.get::<_, bool>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, Option<String>>(10)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    rows.into_iter().map(summary_from_row).collect()
}

#[tauri::command]
pub fn save_script_archive(
    input: SaveScriptArchiveInput,
    state: State<'_, AppDatabase>,
) -> Result<ScriptArchiveSummary, String> {
    if input.script.trim().is_empty() {
        return Err("脚本内容不能为空".to_string());
    }
    if input.script.len() > MAX_ARCHIVE_SCRIPT_BYTES {
        return Err("脚本超过 512 KiB 限制".to_string());
    }
    if !is_valid_identifier(&input.entry) {
        return Err("entry 必须是简单 JavaScript 标识符".to_string());
    }
    let file_name = sanitize_file_name(&input.file_name);
    let name = if input.name.trim().is_empty() {
        file_name.clone()
    } else {
        input.name.trim().to_string()
    };
    let sha256 = script_sha256(&input.script);
    let http_hosts = normalize_host_list(&input.http_hosts);
    let mut http_headers = normalize_http_headers(&input.http_headers)?;
    let cookie = http_headers.remove("Cookie");
    let http_hosts_json = serde_json::to_string(&http_hosts).map_err(|error| error.to_string())?;
    let http_headers_json =
        serde_json::to_string(&http_headers).map_err(|error| error.to_string())?;
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let duplicate = connection
        .query_row(
            "SELECT name FROM script_archives WHERE sha256 = ?1",
            params![&sha256],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(existing_name) = duplicate {
        return Err(format!("脚本内容已存在于档案「{existing_name}」中。"));
    }
    connection
        .execute(
            "INSERT INTO script_archives (name, file_name, sha256, script, entry, http_hosts_json, http_headers_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                name,
                file_name,
                sha256,
                input.script,
                input.entry,
                http_hosts_json,
                http_headers_json
            ],
        )
        .map_err(|error| error.to_string())?;
    let archive_id = connection.last_insert_rowid();
    if let Some(cookie) = cookie {
        if let Err(error) = save_cookie_secret(archive_id, &cookie) {
            let _ = connection.execute(
                "DELETE FROM script_archives WHERE id = ?1",
                params![archive_id],
            );
            return Err(error);
        }
        connection
            .execute(
                "UPDATE script_archives SET cookie_present = 1 WHERE id = ?1",
                params![archive_id],
            )
            .map_err(|error| error.to_string())?;
    }
    load_script_archive(&connection, archive_id).map(|archive| archive.summary)
}

#[tauri::command]
pub fn set_script_archive_enabled(
    archive_id: i64,
    enabled: bool,
    state: State<'_, AppDatabase>,
) -> Result<ScriptArchiveSummary, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let changed = connection
        .execute(
            "UPDATE script_archives SET enabled = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![enabled, archive_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("脚本档案不存在或已被删除".to_string());
    }
    load_script_archive(&connection, archive_id).map(|archive| archive.summary)
}

#[tauri::command]
pub fn delete_script_archive(
    archive_id: i64,
    state: State<'_, AppDatabase>,
) -> Result<Vec<ScriptArchiveSummary>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let deleted = connection
        .execute(
            "UPDATE script_archives SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?1 AND deleted_at IS NULL",
            params![archive_id],
        )
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("脚本档案不存在或已被删除".to_string());
    }
    drop(connection);
    list_script_archives(state)
}

#[tauri::command]
pub fn restore_script_archive(
    archive_id: i64,
    state: State<'_, AppDatabase>,
) -> Result<Vec<ScriptArchiveSummary>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let restored = connection
        .execute(
            "UPDATE script_archives SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
            params![archive_id],
        )
        .map_err(|error| error.to_string())?;
    if restored == 0 {
        return Err("找不到可恢复的脚本档案".to_string());
    }
    drop(connection);
    list_script_archives(state)
}

#[tauri::command]
pub async fn execute_script_archive(
    app: AppHandle,
    archive_id: i64,
    input: Value,
    entry: Option<String>,
    state: State<'_, AppDatabase>,
) -> Result<ScriptExecutionResult, String> {
    run_script_archive(app, archive_id, input, entry, &state.0).await
}

pub(crate) async fn run_script_archive(
    app: AppHandle,
    archive_id: i64,
    input: Value,
    entry: Option<String>,
    database: &Mutex<rusqlite::Connection>,
) -> Result<ScriptExecutionResult, String> {
    let stored = {
        let connection = database.lock().map_err(|_| "数据库锁定失败".to_string())?;
        load_script_archive(&connection, archive_id)?
    };
    if !stored.summary.enabled {
        return Err("脚本档案尚未启用，请先明确开启后再执行。".to_string());
    }
    let mut http_headers = stored.http_headers;
    if stored.summary.has_cookie {
        http_headers.insert("Cookie".to_string(), load_cookie_secret(archive_id)?);
    }
    let result = run_script(
        app,
        ScriptExecutionRequest {
            script: stored.script,
            entry: entry.unwrap_or(stored.summary.entry),
            input,
            http_hosts: stored.summary.http_hosts,
            http_headers,
        },
    )
    .await?;
    let connection = database.lock().map_err(|_| "数据库锁定失败".to_string())?;
    connection
        .execute(
            "UPDATE script_archives SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![archive_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn test_script_source(
    app: AppHandle,
    source: SourceRecord,
    state: State<'_, AppDatabase>,
) -> Result<crate::cms::SourceTestResult, String> {
    let started = Instant::now();
    let source_key = source.key.clone();
    let Some(archive_id) = source.script_archive_id else {
        return Ok(crate::cms::SourceTestResult {
            source_key,
            status: "blocked".to_string(),
            adapter_id: "local-script".to_string(),
            message: "该源尚未绑定本地脚本档案。".to_string(),
            item_count: 0,
            category_count: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            tested_at: "刚刚".to_string(),
            operations: Vec::new(),
        });
    };
    let result = run_script_archive(
        app,
        archive_id,
        json!({"page": 1, "pageSize": 8, "query": "", "categoryId": "all"}),
        Some("getHome".to_string()),
        &state.0,
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(result) => {
            let item_count = raw_collection_len(&result.value) as u64;
            let category_count = raw_collection_len(
                result
                    .value
                    .get("categories")
                    .or_else(|| result.value.get("class"))
                    .unwrap_or(&Value::Null),
            ) as u64;
            let status = if item_count > 0 { "passed" } else { "empty" };
            Ok(crate::cms::SourceTestResult {
                source_key,
                status: status.to_string(),
                adapter_id: "local-script".to_string(),
                message: format!(
                    "脚本 getHome 返回 {} 条内容，产生 {} 次 HTTP host-call。",
                    item_count, result.http_call_count
                ),
                item_count,
                category_count,
                duration_ms,
                tested_at: "刚刚".to_string(),
                operations: vec![SourceOperationResult {
                    operation: "script.getHome".to_string(),
                    status: status.to_string(),
                    message: "本地脚本入口执行完成。".to_string(),
                    duration_ms,
                }],
            })
        }
        Err(error) => Ok(crate::cms::SourceTestResult {
            source_key,
            status: "failed".to_string(),
            adapter_id: "local-script".to_string(),
            message: error.clone(),
            item_count: 0,
            category_count: 0,
            duration_ms,
            tested_at: "刚刚".to_string(),
            operations: vec![SourceOperationResult {
                operation: "script.getHome".to_string(),
                status: "failed".to_string(),
                message: error,
                duration_ms,
            }],
        }),
    }
}

fn raw_collection_len(value: &Value) -> usize {
    if let Some(items) = value.as_array() {
        return items.len();
    }
    let Some(object) = value.as_object() else {
        return 0;
    };
    for key in ["list", "items", "results", "data", "vod", "videos"] {
        if let Some(value) = object.get(key) {
            let count = raw_collection_len(value);
            if count > 0 {
                return count;
            }
        }
    }
    0
}

fn load_script_archive(
    connection: &rusqlite::Connection,
    archive_id: i64,
) -> Result<StoredScriptArchive, String> {
    let row = connection
        .query_row(
            "SELECT id, name, file_name, sha256, script, entry, http_hosts_json, http_headers_json, cookie_present, enabled, imported_at, last_used_at FROM script_archives WHERE id = ?1 AND deleted_at IS NULL",
            params![archive_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, bool>(8)?,
                    row.get::<_, bool>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, Option<String>>(11)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "脚本档案不存在或已被删除".to_string())?;
    let summary = summary_from_row((
        row.0,
        row.1,
        row.2,
        row.3,
        row.5,
        row.6,
        row.7.clone(),
        row.8,
        row.9,
        row.10,
        row.11,
    ))?;
    Ok(StoredScriptArchive {
        summary,
        script: row.4,
        http_headers: serde_json::from_str(&row.7)
            .map_err(|error| format!("脚本档案请求头损坏：{error}"))?,
    })
}

fn summary_from_row(
    row: (
        i64,
        String,
        String,
        String,
        String,
        String,
        String,
        bool,
        bool,
        String,
        Option<String>,
    ),
) -> Result<ScriptArchiveSummary, String> {
    let http_hosts = serde_json::from_str(&row.5)
        .map_err(|error| format!("脚本档案 HTTP allowlist 损坏：{error}"))?;
    let http_headers: HashMap<String, String> =
        serde_json::from_str(&row.6).map_err(|error| format!("脚本档案请求头损坏：{error}"))?;
    let mut http_header_names = http_headers.keys().cloned().collect::<Vec<_>>();
    if row.7 && !http_header_names.iter().any(|name| name == "Cookie") {
        http_header_names.push("Cookie".to_string());
    }
    http_header_names.sort_unstable();
    Ok(ScriptArchiveSummary {
        id: row.0,
        name: row.1,
        file_name: row.2,
        sha256: row.3,
        entry: row.4,
        http_hosts,
        http_header_names,
        has_cookie: row.7,
        enabled: row.8,
        imported_at: row.9,
        last_used_at: row.10,
    })
}

fn script_sha256(script: &str) -> String {
    let digest = Sha256::digest(script.as_bytes());
    format!("{digest:x}")
}

fn sanitize_file_name(file_name: &str) -> String {
    let candidate = Path::new(file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("script.js")
        .trim();
    if candidate.is_empty() {
        "script.js".to_string()
    } else {
        candidate.to_string()
    }
}

fn normalize_host_list(hosts: &[String]) -> Vec<String> {
    let mut normalized = normalize_hosts(hosts).into_iter().collect::<Vec<_>>();
    normalized.sort_unstable();
    normalized
}

fn normalize_http_headers(
    headers: &HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let mut normalized = HashMap::new();
    for (name, value) in headers {
        let canonical = match name.to_ascii_lowercase().as_str() {
            "user-agent" => "User-Agent",
            "referer" => "Referer",
            "cookie" => "Cookie",
            _ => return Err(format!("脚本请求头不在允许列表中：{name}")),
        };
        let max_length = if canonical == "Cookie" { 8192 } else { 4096 };
        if value.len() > max_length || value.contains(['\r', '\n']) {
            return Err(format!("脚本请求头 {canonical} 超出长度或包含换行"));
        }
        normalized.insert(canonical.to_string(), value.clone());
    }
    Ok(normalized)
}

fn cookie_entry(archive_id: i64) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        KEYRING_SERVICE,
        &format!("script-archive-cookie-{archive_id}"),
    )
    .map_err(|error| format!("创建系统凭据条目失败：{error}"))
}

fn save_cookie_secret(archive_id: i64, cookie: &str) -> Result<(), String> {
    cookie_entry(archive_id)?
        .set_password(cookie)
        .map_err(|error| format!("写入 Windows 凭据存储失败：{error}"))
}

fn load_cookie_secret(archive_id: i64) -> Result<String, String> {
    cookie_entry(archive_id)?
        .get_password()
        .map_err(|error| format!("读取脚本 Cookie 凭据失败：{error}"))
}

pub(crate) fn migrate_script_archive_cookies(
    connection: &rusqlite::Connection,
) -> Result<(), String> {
    let rows = connection
        .prepare("SELECT id, http_headers_json, cookie_present FROM script_archives")
        .map_err(|error| error.to_string())?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for (archive_id, headers_json, cookie_present) in rows {
        let mut headers: HashMap<String, String> = serde_json::from_str(&headers_json)
            .map_err(|error| format!("脚本档案请求头损坏：{error}"))?;
        let cookie = headers.remove("Cookie");
        if let Some(cookie) = cookie {
            if !cookie_present {
                save_cookie_secret(archive_id, &cookie)?;
            }
            let sanitized = serde_json::to_string(&headers).map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE script_archives SET http_headers_json = ?1, cookie_present = 1 WHERE id = ?2",
                    params![sanitized, archive_id],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn is_valid_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|character| character == '_' || character == '$' || character.is_ascii_alphanumeric())
}

async fn handle_host_call(
    call: &HostCall,
    allowed_hosts: &HashSet<String>,
    headers: &HashMap<String, String>,
) -> HostResponse {
    if call.kind != "host_call" || call.method != "http_get" {
        return host_error(call.id, "不支持的 host-call 方法");
    }
    let Ok(url) = reqwest::Url::parse(&call.url) else {
        return host_error(call.id, "http_get 地址无效");
    };
    let Some(host) = url.host_str() else {
        return host_error(call.id, "http_get 地址缺少主机名");
    };
    if !allowed_hosts.contains(&host.trim_end_matches('.').to_ascii_lowercase()) {
        return host_error(call.id, "目标主机不在脚本 HTTP allowlist 中");
    }
    if let Err(error) = validate_remote_url(&url) {
        return host_error(call.id, &error);
    }
    let header_pairs = headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<Vec<_>>();
    match fetch_text_with_headers(url, 2 * 1024 * 1024, "脚本 HTTP 响应", &header_pairs).await {
        Ok(body) => HostResponse {
            kind: "hostResponse",
            id: call.id,
            ok: true,
            value: Some(json!({ "body": body })),
            error: None,
        },
        Err(error) => host_error(call.id, &error),
    }
}

fn host_error(id: u64, error: &str) -> HostResponse {
    HostResponse {
        kind: "hostResponse",
        id,
        ok: false,
        value: None,
        error: Some(error.to_string()),
    }
}

fn normalize_hosts(hosts: &[String]) -> HashSet<String> {
    hosts
        .iter()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        .filter(|host| !host.is_empty())
        .collect()
}

fn take_line(buffer: &mut String) -> Option<String> {
    let position = buffer.find('\n')?;
    let line = buffer[..position].trim().to_string();
    buffer.drain(..=position);
    Some(line)
}

fn default_entry() -> String {
    "main".to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_hosts, normalize_http_headers, sanitize_file_name, script_sha256, take_line,
    };
    use std::collections::HashMap;

    #[test]
    fn normalizes_http_host_allowlist() {
        let hosts = normalize_hosts(&["Example.COM.".to_string(), "".to_string()]);
        assert!(hosts.contains("example.com"));
        assert_eq!(hosts.len(), 1);
    }

    #[test]
    fn extracts_one_jsonl_line_at_a_time() {
        let mut buffer = "first\npartial".to_string();
        assert_eq!(take_line(&mut buffer).as_deref(), Some("first"));
        assert_eq!(buffer, "partial");
    }

    #[test]
    fn archives_hash_content_and_strips_file_paths() {
        let first = script_sha256("function main() {}");
        let second = script_sha256("function main() {}");
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert_eq!(sanitize_file_name(r"C:\temp\demo.js"), "demo.js");
    }

    #[test]
    fn only_allows_safe_script_headers_and_rejects_line_breaks() {
        let headers = HashMap::from([
            ("referer".to_string(), "https://example.com".to_string()),
            ("Cookie".to_string(), "sid=demo".to_string()),
        ]);
        let normalized = normalize_http_headers(&headers).unwrap();
        assert_eq!(
            normalized.get("Referer"),
            Some(&"https://example.com".to_string())
        );
        assert_eq!(normalized.get("Cookie"), Some(&"sid=demo".to_string()));

        let invalid = HashMap::from([("Authorization".to_string(), "secret".to_string())]);
        assert!(normalize_http_headers(&invalid).is_err());
        let line_break = HashMap::from([("User-Agent".to_string(), "demo\nnext".to_string())]);
        assert!(normalize_http_headers(&line_break).is_err());
    }
}
