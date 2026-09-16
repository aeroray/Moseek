pub mod archive;

use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::time::timeout;

use crate::policy::{fetch_text_with_headers, validate_remote_url};

const MAX_SCRIPT_EXECUTION_TIME: Duration = Duration::from_secs(20);
const MAX_HOST_CALL_TIME: Duration = Duration::from_secs(16);

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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptHttpDiagnostic {
    pub host: String,
    pub duration_ms: u64,
    pub status: String,
    pub error_kind: Option<String>,
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

struct SidecarChild {
    child: Option<CommandChild>,
}

impl SidecarChild {
    fn new(child: CommandChild) -> Self {
        Self { child: Some(child) }
    }

    fn write(&mut self, bytes: &[u8], context: &str) -> Result<(), String> {
        self.child
            .as_mut()
            .ok_or_else(|| "脚本运行时进程已结束".to_string())?
            .write(bytes)
            .map_err(|error| format!("{context}{error}"))
    }

    fn terminate(&mut self) -> Result<(), String> {
        let Some(child) = self.child.take() else {
            return Ok(());
        };
        child
            .kill()
            .map_err(|error| format!("清理脚本运行时失败：{error}"))
    }
}

impl Drop for SidecarChild {
    fn drop(&mut self) {
        if let Err(error) = self.terminate() {
            eprintln!("{error}");
        }
    }
}

struct ScriptRunOutcome {
    value: Result<Value, String>,
    http_call_count: u32,
    http_calls: Vec<ScriptHttpDiagnostic>,
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
    let http_headers = archive::normalize_http_headers(&request.http_headers)?;
    let mut request = request;
    request.http_headers = http_headers.clone();
    let request_json = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let sidecar = app
        .shell()
        .sidecar("moseek-script-runtime")
        .map_err(|error| format!("找不到脚本运行时 sidecar：{error}"))?;
    let (mut events, child) = sidecar
        .spawn()
        .map_err(|error| format!("启动脚本运行时失败：{error}"))?;
    let mut child = SidecarChild::new(child);
    child.write(
        format!("{request_json}\n").as_bytes(),
        "发送脚本运行请求失败：",
    )?;

    let mut stdout_buffer = String::new();
    let mut http_call_count = 0;
    let mut http_calls = Vec::new();
    let loop_result: Result<Result<Value, String>, String> = async {
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
                            let response_json = format!(
                                "{}\n",
                                serde_json::to_string(&response)
                                    .map_err(|error| error.to_string())?
                            );
                            child.write(response_json.as_bytes(), "返回 host-call 结果失败：")?;
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
        Ok(final_result.unwrap_or_else(|| Err("脚本运行时没有返回结果".to_string())))
    }
    .await;
    let result = loop_result.unwrap_or_else(Err);
    if let Err(error) = child.terminate() {
        return Ok(ScriptRunOutcome {
            value: Err(error),
            http_call_count,
            http_calls,
        });
    }
    Ok(ScriptRunOutcome {
        value: result,
        http_call_count,
        http_calls,
    })
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

pub(super) fn record_script_execution_log(
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
    let _ = connection.execute(
        "DELETE FROM script_execution_logs WHERE id NOT IN (SELECT id FROM script_execution_logs ORDER BY id DESC LIMIT 500)",
        [],
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
        diagnostics_for_result, normalize_hosts, script_http_diagnostic, take_line, HostResponse,
        ScriptRunOutcome,
    };
    use crate::script_runtime::archive::normalize_http_headers;
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
