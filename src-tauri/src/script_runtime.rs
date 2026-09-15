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
    #[serde(default)]
    pub modules: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptExecutionResult {
    pub value: Value,
    pub adapter_id: String,
    pub http_call_count: u32,
    pub diagnostics: ScriptExecutionDiagnostics,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptExecutionDiagnostics {
    pub status: String,
    pub phase: String,
    pub duration_ms: u64,
    pub http_call_count: u32,
    pub http_hosts: Vec<String>,
    pub http_calls: Vec<ScriptHttpDiagnostic>,
    pub error_kind: Option<String>,
    pub timed_out: bool,
    pub credential_lookup_failed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptExecutionLog {
    pub id: i64,
    pub archive_id: Option<i64>,
    pub entry: String,
    pub status: String,
    pub phase: String,
    pub duration_ms: u64,
    pub http_call_count: u32,
    pub http_hosts: Vec<String>,
    pub http_calls: Vec<ScriptHttpDiagnostic>,
    pub error_kind: Option<String>,
    pub timed_out: bool,
    pub credential_lookup_failed: bool,
    pub created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptHttpDiagnostic {
    pub host: String,
    pub duration_ms: u64,
    pub status: String,
    pub error_kind: Option<String>,
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
    #[serde(default)]
    pub modules: HashMap<String, String>,
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
    pub module_names: Vec<String>,
    pub has_cookie: bool,
    pub enabled: bool,
    pub imported_at: String,
    pub last_used_at: Option<String>,
}

struct StoredScriptArchive {
    summary: ScriptArchiveSummary,
    script: String,
    http_headers: HashMap<String, String>,
    modules: HashMap<String, String>,
}

struct ScriptRunOutcome {
    value: Result<Value, String>,
    http_call_count: u32,
    http_calls: Vec<ScriptHttpDiagnostic>,
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
    state: State<'_, AppDatabase>,
) -> Result<ScriptExecutionResult, String> {
    run_script(app, request, &state.0, None).await
}

async fn run_script(
    app: AppHandle,
    request: ScriptExecutionRequest,
    database: &Mutex<rusqlite::Connection>,
    archive_id: Option<i64>,
) -> Result<ScriptExecutionResult, String> {
    let started = Instant::now();
    let entry = request.entry.clone();
    let result = run_script_inner(app, request).await;
    let diagnostics = diagnostics_for_result(&result, started.elapsed());
    record_script_execution_log(database, archive_id, &entry, &diagnostics);
    match result {
        Ok(outcome) => Ok(ScriptExecutionResult {
            value: outcome.value?,
            adapter_id: "quickjs-sidecar".to_string(),
            http_call_count: outcome.http_call_count,
            diagnostics,
        }),
        Err(error) => Err(error),
    }
}

async fn run_script_inner(
    app: AppHandle,
    request: ScriptExecutionRequest,
) -> Result<ScriptRunOutcome, String> {
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
    let mut http_calls = Vec::new();
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
                        let call_started = Instant::now();
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
                            http_calls.push(script_http_diagnostic(
                                &call.url,
                                &response,
                                call_started.elapsed(),
                            ));
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
    Ok(ScriptRunOutcome {
        value: result,
        http_call_count,
        http_calls,
    })
}

#[tauri::command]
pub fn list_script_archives(
    state: State<'_, AppDatabase>,
) -> Result<Vec<ScriptArchiveSummary>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let rows = connection
        .prepare(
            "SELECT id, name, file_name, sha256, entry, http_hosts_json, http_headers_json, modules_json, cookie_present, enabled, imported_at, last_used_at FROM script_archives WHERE deleted_at IS NULL ORDER BY id DESC",
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
                row.get::<_, String>(7)?,
                row.get::<_, bool>(8)?,
                row.get::<_, bool>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, Option<String>>(11)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    rows.into_iter().map(summary_from_row).collect()
}

#[tauri::command]
pub fn list_script_execution_logs(
    limit: Option<u32>,
    state: State<'_, AppDatabase>,
) -> Result<Vec<ScriptExecutionLog>, String> {
    let limit = i64::from(limit.unwrap_or(20).clamp(1, 100));
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, archive_id, entry, status, phase, duration_ms, http_call_count, http_hosts_json, http_calls_json, error_kind, timed_out, credential_lookup_failed, created_at FROM script_execution_logs ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, bool>(10)?,
                row.get::<_, bool>(11)?,
                row.get::<_, String>(12)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    rows.into_iter()
        .map(|row| {
            Ok(ScriptExecutionLog {
                id: row.0,
                archive_id: row.1,
                entry: row.2,
                status: row.3,
                phase: row.4,
                duration_ms: row.5.max(0) as u64,
                http_call_count: row.6.max(0) as u32,
                http_hosts: serde_json::from_str(&row.7)
                    .map_err(|error| format!("脚本日志 host 列表损坏：{error}"))?,
                http_calls: serde_json::from_str(&row.8)
                    .map_err(|error| format!("脚本日志 HTTP 明细损坏：{error}"))?,
                error_kind: row.9,
                timed_out: row.10,
                credential_lookup_failed: row.11,
                created_at: row.12,
            })
        })
        .collect()
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
    validate_script_modules(&input.modules)?;
    let mut http_headers = normalize_http_headers(&input.http_headers)?;
    let cookie = http_headers.remove("Cookie");
    let http_hosts_json = serde_json::to_string(&http_hosts).map_err(|error| error.to_string())?;
    let http_headers_json =
        serde_json::to_string(&http_headers).map_err(|error| error.to_string())?;
    let modules_json = serde_json::to_string(&input.modules).map_err(|error| error.to_string())?;
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
            "INSERT INTO script_archives (name, file_name, sha256, script, entry, http_hosts_json, http_headers_json, modules_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                name,
                file_name,
                sha256,
                input.script,
                input.entry,
                http_hosts_json,
                http_headers_json,
                modules_json
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
pub fn purge_script_archive(
    archive_id: i64,
    state: State<'_, AppDatabase>,
) -> Result<Vec<ScriptArchiveSummary>, String> {
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let row = connection
        .query_row(
            "SELECT enabled, cookie_present FROM script_archives WHERE id = ?1",
            params![archive_id],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "脚本档案不存在或已被删除".to_string())?;
    if row.0 {
        return Err("请先停用脚本档案，再永久删除其凭据和内容。".to_string());
    }
    if row.1 {
        delete_cookie_secret(archive_id)?;
    }
    let deleted = connection
        .execute(
            "DELETE FROM script_archives WHERE id = ?1",
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
    let execution_entry = entry.unwrap_or_else(|| stored.summary.entry.clone());
    let mut http_headers = stored.http_headers;
    if stored.summary.has_cookie {
        match load_cookie_secret(archive_id) {
            Ok(cookie) => {
                http_headers.insert("Cookie".to_string(), cookie);
            }
            Err(error) => {
                let diagnostics = ScriptExecutionDiagnostics {
                    status: "failed".to_string(),
                    phase: "credential".to_string(),
                    duration_ms: 0,
                    http_call_count: 0,
                    http_hosts: Vec::new(),
                    http_calls: Vec::new(),
                    error_kind: Some("credential".to_string()),
                    timed_out: false,
                    credential_lookup_failed: true,
                };
                record_script_execution_log(
                    database,
                    Some(archive_id),
                    &execution_entry,
                    &diagnostics,
                );
                return Err(error);
            }
        }
    }
    let result = run_script(
        app,
        ScriptExecutionRequest {
            script: stored.script,
            entry: execution_entry,
            input,
            http_hosts: stored.summary.http_hosts,
            http_headers,
            modules: stored.modules,
        },
        database,
        Some(archive_id),
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
            "SELECT id, name, file_name, sha256, script, entry, http_hosts_json, http_headers_json, modules_json, cookie_present, enabled, imported_at, last_used_at FROM script_archives WHERE id = ?1 AND deleted_at IS NULL",
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
                    row.get::<_, String>(8)?,
                    row.get::<_, bool>(9)?,
                    row.get::<_, bool>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<String>>(12)?,
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
        row.8.clone(),
        row.9,
        row.10,
        row.11,
        row.12,
    ))?;
    Ok(StoredScriptArchive {
        summary,
        script: row.4,
        http_headers: serde_json::from_str(&row.7)
            .map_err(|error| format!("脚本档案请求头损坏：{error}"))?,
        modules: serde_json::from_str(&row.8)
            .map_err(|error| format!("脚本档案模块映射损坏：{error}"))?,
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
    let mut module_names = serde_json::from_str::<HashMap<String, String>>(&row.7)
        .map_err(|error| format!("脚本档案模块映射损坏：{error}"))?
        .into_keys()
        .collect::<Vec<_>>();
    module_names.sort_unstable();
    let mut http_header_names = http_headers.keys().cloned().collect::<Vec<_>>();
    if row.8 && !http_header_names.iter().any(|name| name == "Cookie") {
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
        module_names,
        has_cookie: row.8,
        enabled: row.9,
        imported_at: row.10,
        last_used_at: row.11,
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

fn validate_script_modules(modules: &HashMap<String, String>) -> Result<(), String> {
    if modules.len() > 32 {
        return Err("脚本模块数量超过 32 个限制".to_string());
    }
    let mut total_bytes = 0;
    for (name, source) in modules {
        let name = name.trim();
        if name.is_empty() || name.contains('\\') || name.contains(':') || name.starts_with('/') {
            return Err(format!("脚本模块名无效：{name}"));
        }
        if source.len() > 256 * 1024 {
            return Err(format!("脚本模块 {name} 超过 256 KiB 限制"));
        }
        total_bytes += source.len();
        if total_bytes > 512 * 1024 {
            return Err("脚本模块总大小超过 512 KiB 限制".to_string());
        }
    }
    Ok(())
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

fn delete_cookie_secret(archive_id: i64) -> Result<(), String> {
    match cookie_entry(archive_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除 Windows 凭据失败：{error}")),
    }
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

fn diagnostics_for_result(
    result: &Result<ScriptRunOutcome, String>,
    duration: Duration,
) -> ScriptExecutionDiagnostics {
    match result {
        Ok(outcome) => match &outcome.value {
            Ok(_) => ScriptExecutionDiagnostics {
                status: "ok".to_string(),
                phase: "complete".to_string(),
                duration_ms: duration.as_millis() as u64,
                http_call_count: outcome.http_call_count,
                http_hosts: unique_hosts(&outcome.http_calls),
                http_calls: outcome.http_calls.clone(),
                error_kind: None,
                timed_out: false,
                credential_lookup_failed: false,
            },
            Err(error) => failed_diagnostics(
                error,
                duration,
                outcome.http_call_count,
                &outcome.http_calls,
            ),
        },
        Err(error) => failed_diagnostics(error, duration, 0, &[]),
    }
}

fn failed_diagnostics(
    error: &str,
    duration: Duration,
    http_call_count: u32,
    http_calls: &[ScriptHttpDiagnostic],
) -> ScriptExecutionDiagnostics {
    let error_kind = classify_script_error(error);
    ScriptExecutionDiagnostics {
        status: "failed".to_string(),
        phase: script_error_phase(error, &error_kind).to_string(),
        duration_ms: duration.as_millis() as u64,
        http_call_count,
        http_hosts: unique_hosts(http_calls),
        http_calls: http_calls.to_vec(),
        timed_out: error_kind == "timeout",
        credential_lookup_failed: error_kind == "credential",
        error_kind: Some(error_kind),
    }
}

fn script_http_diagnostic(
    url: &str,
    response: &HostResponse,
    duration: Duration,
) -> ScriptHttpDiagnostic {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
        .unwrap_or_else(|| "<invalid>".to_string());
    ScriptHttpDiagnostic {
        host,
        duration_ms: duration.as_millis() as u64,
        status: if response.ok {
            "ok".to_string()
        } else {
            "error".to_string()
        },
        error_kind: response.error.as_deref().map(classify_script_error),
    }
}

fn unique_hosts(calls: &[ScriptHttpDiagnostic]) -> Vec<String> {
    let mut hosts = calls
        .iter()
        .map(|call| call.host.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    hosts.sort_unstable();
    hosts
}

fn classify_script_error(error: &str) -> String {
    if error.contains("Cookie") || error.contains("凭据") {
        "credential".to_string()
    } else if error.contains("超过") || error.to_ascii_lowercase().contains("timeout") {
        "timeout".to_string()
    } else if error.contains("HTTP") || error.contains("http_get") || error.contains("host-call") {
        "http".to_string()
    } else if error.contains("入口") {
        "entry".to_string()
    } else if error.contains("脚本") {
        "script".to_string()
    } else {
        "runtime".to_string()
    }
}

fn script_error_phase(error: &str, error_kind: &str) -> &'static str {
    match error_kind {
        "credential" => "credential",
        "timeout" => "timeout",
        "http" => "host-call",
        "entry" => "entry",
        _ if error.contains("启动") || error.contains("发送") => "spawn",
        _ => "runtime",
    }
}

fn record_script_execution_log(
    database: &Mutex<rusqlite::Connection>,
    archive_id: Option<i64>,
    entry: &str,
    diagnostics: &ScriptExecutionDiagnostics,
) {
    let Ok(connection) = database.lock() else {
        return;
    };
    let http_hosts_json =
        serde_json::to_string(&diagnostics.http_hosts).unwrap_or_else(|_| "[]".to_string());
    let http_calls_json =
        serde_json::to_string(&diagnostics.http_calls).unwrap_or_else(|_| "[]".to_string());
    let _ = connection.execute(
        "INSERT INTO script_execution_logs (archive_id, entry, status, phase, duration_ms, http_call_count, http_hosts_json, http_calls_json, error_kind, timed_out, credential_lookup_failed) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            archive_id,
            entry,
            diagnostics.status,
            diagnostics.phase,
            diagnostics.duration_ms,
            diagnostics.http_call_count,
            http_hosts_json,
            http_calls_json,
            diagnostics.error_kind,
            diagnostics.timed_out,
            diagnostics.credential_lookup_failed,
        ],
    );
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
        diagnostics_for_result, normalize_hosts, normalize_http_headers, sanitize_file_name,
        script_http_diagnostic, script_sha256, take_line, HostResponse, ScriptRunOutcome,
    };
    use std::collections::HashMap;
    use std::time::Duration;

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

    #[test]
    fn diagnostics_keep_only_host_and_classify_script_failures() {
        let response = HostResponse {
            kind: "hostResponse",
            id: 1,
            ok: true,
            value: None,
            error: None,
        };
        let call = script_http_diagnostic(
            "https://Example.com/api?token=secret",
            &response,
            Duration::from_millis(4),
        );
        let result = Ok(ScriptRunOutcome {
            value: Err("脚本入口执行失败".to_string()),
            http_call_count: 1,
            http_calls: vec![call],
        });
        let diagnostics = diagnostics_for_result(&result, Duration::from_millis(8));
        assert_eq!(diagnostics.status, "failed");
        assert_eq!(diagnostics.error_kind.as_deref(), Some("entry"));
        assert_eq!(diagnostics.http_call_count, 1);
        assert_eq!(diagnostics.http_hosts, vec!["example.com"]);
        assert_eq!(diagnostics.http_calls[0].status, "ok");
    }
}
