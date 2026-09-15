use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, BufWriter, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_SCRIPT_BYTES: usize = 512 * 1024;
const MAX_INPUT_BYTES: usize = 512 * 1024;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_MEMORY_BYTES: usize = 8 * 1024 * 1024;
const MAX_STACK_BYTES: usize = 256 * 1024;
const MAX_EXECUTION_TIME: Duration = Duration::from_millis(1_500);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRequest {
    script: String,
    #[serde(default = "default_entry")]
    entry: String,
    #[serde(default)]
    input: Value,
    #[serde(default)]
    http_hosts: Vec<String>,
    #[serde(default)]
    #[serde(rename = "httpHeaders")]
    _http_headers: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
struct RuntimeResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCall {
    kind: &'static str,
    id: u64,
    method: &'static str,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostResponse {
    kind: String,
    id: u64,
    ok: bool,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

struct Transport {
    input: BufReader<io::Stdin>,
    output: BufWriter<io::Stdout>,
    next_id: u64,
}

impl Transport {
    fn new() -> Self {
        Self {
            input: BufReader::new(io::stdin()),
            output: BufWriter::new(io::stdout()),
            next_id: 1,
        }
    }

    fn read_line(&mut self) -> io::Result<Option<String>> {
        let mut line = String::new();
        let bytes = self.input.read_line(&mut line)?;
        if bytes == 0 {
            return Ok(None);
        }
        Ok(Some(line))
    }

    fn write_json<T: Serialize>(&mut self, value: &T) -> io::Result<()> {
        serde_json::to_writer(&mut self.output, value).map_err(io::Error::other)?;
        self.output.write_all(b"\n")?;
        self.output.flush()
    }

    fn request_http(&mut self, url: &str) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.write_json(&HostCall {
            kind: "host_call",
            id,
            method: "http_get",
            url: url.to_string(),
        })
        .map_err(|error| format!("发送 http_get 宿主调用失败：{error}"))?;

        loop {
            let line = self
                .read_line()
                .map_err(|error| format!("读取 http_get 宿主响应失败：{error}"))?
                .ok_or_else(|| "http_get 宿主响应提前结束".to_string())?;
            let response = serde_json::from_str::<HostResponse>(&line)
                .map_err(|error| format!("http_get 宿主响应不是有效 JSON：{error}"))?;
            if response.kind != "hostResponse" || response.id != id {
                return Err("http_get 宿主响应 ID 或类型不匹配".to_string());
            }
            if !response.ok {
                return Err(response
                    .error
                    .unwrap_or_else(|| "http_get 宿主调用失败".to_string()));
            }
            return Ok(response.value.unwrap_or(Value::Null));
        }
    }
}

fn main() {
    let transport = Arc::new(Mutex::new(Transport::new()));
    loop {
        let line = {
            let mut transport = match transport.lock() {
                Ok(transport) => transport,
                Err(_) => break,
            };
            match transport.read_line() {
                Ok(Some(line)) => line,
                Ok(None) | Err(_) => break,
            }
        };
        let response = match line {
            line if line.len() <= MAX_OUTPUT_BYTES => {
                response_for_line(&line, Arc::clone(&transport))
            }
            _ => error_response("请求超过运行时输入大小限制"),
        };
        if let Ok(mut transport) = transport.lock() {
            let _ = transport.write_json(&response);
        } else {
            break;
        }
    }
}

fn response_for_line(line: &str, transport: Arc<Mutex<Transport>>) -> RuntimeResponse {
    match serde_json::from_str::<RuntimeRequest>(line) {
        Ok(request) => match execute_request(request, MAX_EXECUTION_TIME, transport) {
            Ok(value) => RuntimeResponse {
                ok: true,
                value: Some(value),
                error: None,
            },
            Err(error) => error_response(&error),
        },
        Err(error) => error_response(&format!("运行时请求不是有效 JSON：{error}")),
    }
}

fn execute_request(
    request: RuntimeRequest,
    timeout: Duration,
    transport: Arc<Mutex<Transport>>,
) -> Result<Value, String> {
    if request.script.len() > MAX_SCRIPT_BYTES {
        return Err("脚本超过 512 KiB 限制".to_string());
    }
    if !is_valid_identifier(&request.entry) {
        return Err("entry 必须是简单 JavaScript 标识符".to_string());
    }
    let input_json =
        serde_json::to_string(&request.input).map_err(|error| format!("输入编码失败：{error}"))?;
    if input_json.len() > MAX_INPUT_BYTES {
        return Err("脚本输入超过 512 KiB 限制".to_string());
    }

    let runtime = Runtime::new().map_err(|error| format!("创建 JS 运行时失败：{error}"))?;
    runtime.set_memory_limit(MAX_MEMORY_BYTES);
    runtime.set_max_stack_size(MAX_STACK_BYTES);
    let interrupted = Arc::new(AtomicBool::new(false));
    let interrupt_flag = Arc::clone(&interrupted);
    let deadline = Instant::now() + timeout;
    runtime.set_interrupt_handler(Some(Box::new(move || {
        let expired = Instant::now() >= deadline;
        if expired {
            interrupt_flag.store(true, Ordering::Relaxed);
        }
        expired || interrupt_flag.load(Ordering::Relaxed)
    })));

    let context =
        Context::full(&runtime).map_err(|error| format!("创建 JS 上下文失败：{error}"))?;
    let allowed_hosts = request.http_hosts.clone();
    let result = context.with(|ctx| -> Result<Value, String> {
        let globals = ctx.globals();
        globals
            .set("__moseek_input_json", input_json)
            .map_err(|error| format!("注入脚本输入失败：{error}"))?;
        if !allowed_hosts.is_empty() {
            let transport = Arc::clone(&transport);
            let allowed_hosts = allowed_hosts.clone();
            let http_get = Function::new(ctx.clone(), move |url: String| -> String {
                if !is_allowed_http_url(&url, &allowed_hosts) {
                    return serde_json::to_string(&json!({
                        "ok": false,
                        "error": "目标主机不在脚本 HTTP allowlist 中"
                    }))
                    .unwrap_or_else(|_| "{\"ok\":false}".to_string());
                }
                let response = transport
                    .lock()
                    .map_err(|_| "宿主传输锁定失败".to_string())
                    .and_then(|mut transport| transport.request_http(&url));
                match response {
                    Ok(value) => serde_json::to_string(&value)
                        .unwrap_or_else(|_| "{\"ok\":false}".to_string()),
                    Err(error) => serde_json::to_string(&json!({
                        "ok": false,
                        "error": error
                    }))
                    .unwrap_or_else(|_| "{\"ok\":false}".to_string()),
                }
            })
            .map_err(|error| format!("注册 http_get 宿主 API 失败：{error}"))?;
            globals
                .set("http_get", http_get)
                .map_err(|error| format!("注入 http_get 宿主 API 失败：{error}"))?;
        }
        let prepared_script = prepare_script(&request.script);
        ctx.eval::<(), _>(prepared_script.as_str())
            .map_err(|error| format!("脚本执行失败：{error}"))?;
        let invocation = format!(
            "(function() {{ const result = {entry}(JSON.parse(__moseek_input_json)); return JSON.stringify(result === undefined ? null : result); }})()",
            entry = request.entry
        );
        let output: String = ctx
            .eval(invocation.as_str())
            .map_err(|error| format!("脚本入口执行失败：{error}"))?;
        if output.len() > MAX_OUTPUT_BYTES {
            return Err("脚本输出超过 2 MiB 限制".to_string());
        }
        serde_json::from_str(&output).map_err(|error| format!("脚本输出不是有效 JSON：{error}"))
    });

    if interrupted.load(Ordering::Relaxed) {
        Err("脚本执行超过时间限制".to_string())
    } else {
        result
    }
}

fn is_allowed_http_url(url: &str, allowed_hosts: &[String]) -> bool {
    let Ok(url) = url::Url::parse(url) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    allowed_hosts
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed.trim_end_matches('.')))
}

fn prepare_script(script: &str) -> String {
    script
        .replace("export default async function", "async function")
        .replace("export default function", "function")
        .replace("export default class", "class")
        .replace("export async function", "async function")
        .replace("export function", "function")
        .replace("export class", "class")
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

fn default_entry() -> String {
    "main".to_string()
}

fn error_response(error: &str) -> RuntimeResponse {
    RuntimeResponse {
        ok: false,
        value: None,
        error: Some(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{execute_request, is_allowed_http_url, prepare_script, RuntimeRequest};
    use serde_json::json;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn executes_a_local_json_function_without_host_apis() {
        let value = execute_request(
            RuntimeRequest {
                script: "function main(input) { return { title: input.title.toUpperCase(), fetchType: typeof fetch }; }".to_string(),
                entry: "main".to_string(),
                input: json!({"title": "demo"}),
                http_hosts: Vec::new(),
                _http_headers: HashMap::new(),
            },
            Duration::from_millis(500),
            Arc::new(Mutex::new(super::Transport::new())),
        )
        .unwrap();
        assert_eq!(value["title"], "DEMO");
        assert_eq!(value["fetchType"], "undefined");
    }

    #[test]
    fn interrupts_infinite_scripts() {
        let result = execute_request(
            RuntimeRequest {
                script: "function main() { while (true) {} }".to_string(),
                entry: "main".to_string(),
                input: Value::Null,
                http_hosts: Vec::new(),
                _http_headers: HashMap::new(),
            },
            Duration::from_millis(20),
            Arc::new(Mutex::new(super::Transport::new())),
        );
        assert!(result.is_err());
    }

    #[test]
    fn http_host_must_match_explicit_allowlist() {
        assert!(is_allowed_http_url(
            "https://example.com/api",
            &["example.com".to_string()]
        ));
        assert!(!is_allowed_http_url(
            "https://other.example/api",
            &["example.com".to_string()]
        ));
    }

    #[test]
    fn prepares_named_module_exports_for_entry_calls() {
        let value = execute_request(
            RuntimeRequest {
                script: "export function getHome(input) { return { title: input.title }; }"
                    .to_string(),
                entry: "getHome".to_string(),
                input: json!({"title": "demo"}),
                http_hosts: Vec::new(),
                _http_headers: HashMap::new(),
            },
            Duration::from_millis(500),
            Arc::new(Mutex::new(super::Transport::new())),
        )
        .unwrap();
        assert_eq!(value["title"], "demo");
        assert_eq!(
            prepare_script("export async function getHome() {}"),
            "async function getHome() {}"
        );
    }
}
