use std::{
    collections::HashSet,
    path::Path,
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

use crate::policy::{fetch_text, validate_remote_url};
use crate::AppDatabase;

const MAX_SCRIPT_EXECUTION_TIME: Duration = Duration::from_secs(20);
const MAX_HOST_CALL_TIME: Duration = Duration::from_secs(16);
const MAX_ARCHIVE_SCRIPT_BYTES: usize = 512 * 1024;

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
    pub enabled: bool,
    pub imported_at: String,
    pub last_used_at: Option<String>,
}

struct StoredScriptArchive {
    summary: ScriptArchiveSummary,
    script: String,
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
                            handle_host_call(&call, &allowed_hosts),
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
            "SELECT id, name, file_name, sha256, entry, http_hosts_json, enabled, imported_at, last_used_at FROM script_archives WHERE deleted_at IS NULL ORDER BY id DESC",
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
                row.get::<_, bool>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
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
    let http_hosts_json = serde_json::to_string(&http_hosts).map_err(|error| error.to_string())?;
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
            "INSERT INTO script_archives (name, file_name, sha256, script, entry, http_hosts_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![name, file_name, sha256, input.script, input.entry, http_hosts_json],
        )
        .map_err(|error| error.to_string())?;
    let archive_id = connection.last_insert_rowid();
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
    state: State<'_, AppDatabase>,
) -> Result<ScriptExecutionResult, String> {
    let stored = {
        let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
        load_script_archive(&connection, archive_id)?
    };
    if !stored.summary.enabled {
        return Err("脚本档案尚未启用，请先明确开启后再执行。".to_string());
    }
    let result = run_script(
        app,
        ScriptExecutionRequest {
            script: stored.script,
            entry: stored.summary.entry,
            input,
            http_hosts: stored.summary.http_hosts,
        },
    )
    .await?;
    let connection = state.0.lock().map_err(|_| "数据库锁定失败".to_string())?;
    connection
        .execute(
            "UPDATE script_archives SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![archive_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn load_script_archive(
    connection: &rusqlite::Connection,
    archive_id: i64,
) -> Result<StoredScriptArchive, String> {
    let row = connection
        .query_row(
            "SELECT id, name, file_name, sha256, script, entry, http_hosts_json, enabled, imported_at, last_used_at FROM script_archives WHERE id = ?1 AND deleted_at IS NULL",
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
                    row.get::<_, bool>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "脚本档案不存在或已被删除".to_string())?;
    let summary = summary_from_row((
        row.0, row.1, row.2, row.3, row.5, row.6, row.7, row.8, row.9,
    ))?;
    Ok(StoredScriptArchive {
        summary,
        script: row.4,
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
        bool,
        String,
        Option<String>,
    ),
) -> Result<ScriptArchiveSummary, String> {
    let http_hosts = serde_json::from_str(&row.5)
        .map_err(|error| format!("脚本档案 HTTP allowlist 损坏：{error}"))?;
    Ok(ScriptArchiveSummary {
        id: row.0,
        name: row.1,
        file_name: row.2,
        sha256: row.3,
        entry: row.4,
        http_hosts,
        enabled: row.6,
        imported_at: row.7,
        last_used_at: row.8,
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

async fn handle_host_call(call: &HostCall, allowed_hosts: &HashSet<String>) -> HostResponse {
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
    match fetch_text(url, 2 * 1024 * 1024, "脚本 HTTP 响应").await {
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
    use super::{normalize_hosts, sanitize_file_name, script_sha256, take_line};

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
}
