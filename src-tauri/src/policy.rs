use std::{
    net::{IpAddr, ToSocketAddrs},
    time::Duration,
};

use reqwest::{
    header::{HeaderName, HeaderValue},
    Client, Method, Url,
};
use serde_json::Value;

pub(crate) fn validate_remote_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只允许 HTTP 或 HTTPS 地址".to_string());
    }
    let host = url.host_str().ok_or_else(|| "地址缺少主机名".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    if is_disallowed_host(host) || resolves_to_disallowed_address(host, port) {
        return Err("本机和局域网地址默认未授权，请在设置中主动开启".to_string());
    }
    Ok(())
}

pub(crate) async fn fetch_text(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
) -> Result<String, String> {
    fetch_text_with_headers(url, max_bytes, resource_name, &[]).await
}

pub(crate) async fn fetch_text_with_headers(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
) -> Result<String, String> {
    fetch_text_with_method(url, Method::GET, max_bytes, resource_name, headers, None).await
}

pub(crate) async fn fetch_text_with_method(
    url: Url,
    method: Method,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
) -> Result<String, String> {
    validate_remote_url(&url)?;
    let body =
        fetch_bytes_with_request(url, method, max_bytes, resource_name, headers, body).await?;
    String::from_utf8(body).map_err(|_| format!("{resource_name}不是有效的 UTF-8 文本"))
}

pub(crate) async fn fetch_media_bytes(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
) -> Result<(Vec<u8>, Option<String>, Url), String> {
    fetch_response_bytes(url, Method::GET, max_bytes, resource_name, headers, None, 3).await
}

pub(crate) async fn fetch_json(
    url: Url,
    max_bytes: usize,
    resource_name: &str,
) -> Result<Value, String> {
    let body = fetch_bytes(url, max_bytes, resource_name).await?;
    serde_json::from_slice(&body).map_err(|error| format!("{resource_name}不是有效 JSON：{error}"))
}

async fn fetch_bytes(url: Url, max_bytes: usize, resource_name: &str) -> Result<Vec<u8>, String> {
    fetch_bytes_with_request(url, Method::GET, max_bytes, resource_name, &[], None).await
}

async fn fetch_bytes_with_request(
    url: Url,
    method: Method,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    fetch_response_bytes(url, method, max_bytes, resource_name, headers, body, 0)
        .await
        .map(|(body, _, _)| body)
}

async fn fetch_response_bytes(
    url: Url,
    method: Method,
    max_bytes: usize,
    resource_name: &str,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
    max_redirects: usize,
) -> Result<(Vec<u8>, Option<String>, Url), String> {
    let mut current_url = url;
    for redirect_index in 0..=max_redirects {
        validate_remote_url(&current_url)?;
        let client = build_http_client(&current_url)?;
        let mut request = client.request(method.clone(), current_url.clone());
        for (name, value) in headers {
            if matches!(
                name.to_ascii_lowercase().as_str(),
                "host"
                    | "content-length"
                    | "connection"
                    | "transfer-encoding"
                    | "proxy-authorization"
                    | "proxy-authenticate"
                    | "keep-alive"
                    | "te"
                    | "trailer"
                    | "upgrade"
            ) {
                return Err(format!("不允许覆盖受保护的 HTTP 请求头：{name}"));
            }
            let header_name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| format!("无效的 HTTP 请求头名称：{error}"))?;
            let header_value = HeaderValue::from_str(value)
                .map_err(|error| format!("无效的 HTTP 请求头值：{error}"))?;
            request = request.header(header_name, header_value);
        }
        if let Some(body) = body.clone() {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        if response.status().is_redirection() {
            if redirect_index == max_redirects {
                return Err(format!("{resource_name}重定向次数超过限制"));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or_else(|| format!("{resource_name}重定向缺少目标地址"))?
                .to_str()
                .map_err(|error| format!("{resource_name}重定向地址无效：{error}"))?;
            current_url = current_url
                .join(location)
                .map_err(|error| format!("{resource_name}重定向地址无法解析：{error}"))?;
            continue;
        }
        let mut response = response
            .error_for_status()
            .map_err(|error| error.to_string())?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes as u64)
        {
            return Err(format!(
                "{resource_name}响应超过 {} MB 限制",
                max_bytes / 1024 / 1024
            ));
        }
        let mut body = Vec::with_capacity(
            response
                .content_length()
                .map(|size| size.min(max_bytes as u64) as usize)
                .unwrap_or_default(),
        );
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if body.len().saturating_add(chunk.len()) > max_bytes {
                return Err(format!(
                    "{resource_name}响应超过 {} MB 限制",
                    max_bytes / 1024 / 1024
                ));
            }
            body.extend_from_slice(&chunk);
        }
        return Ok((body, content_type, current_url));
    }
    Err(format!("{resource_name}请求未返回有效响应"))
}

fn build_http_client(url: &Url) -> Result<Client, String> {
    let host = url.host_str().ok_or_else(|| "地址缺少主机名".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    let resolved_address = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析远程主机：{error}"))?
        .find(|address| !is_disallowed_ip(address.ip()))
        .ok_or_else(|| "远程主机没有通过网络地址策略".to_string())?;
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(host, resolved_address)
        .user_agent("Moseek/0.1")
        .build()
        .map_err(|error| error.to_string())
}

fn is_disallowed_host(host: &str) -> bool {
    let normalized_host = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized_host == "localhost"
        || normalized_host.ends_with(".localhost")
        || normalized_host.ends_with(".local")
    {
        return true;
    }
    match normalized_host.parse::<IpAddr>() {
        Ok(address) => is_disallowed_ip(address),
        Err(_) => false,
    }
}

fn resolves_to_disallowed_address(host: &str, port: u16) -> bool {
    match (host, port).to_socket_addrs() {
        Ok(mut addresses) => addresses.any(|address| is_disallowed_ip(address.ip())),
        Err(_) => false,
    }
}

fn is_disallowed_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_broadcast()
        }
        IpAddr::V6(address) => {
            address
                .to_ipv4_mapped()
                .is_some_and(|mapped| is_disallowed_ip(IpAddr::V4(mapped)))
                || address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (address.segments()[0] & 0xffc0 == 0xfe80)
                || (address.segments()[0] & 0xfe00 == 0xfc00)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::validate_remote_url;

    #[test]
    fn policy_rejects_non_http_and_local_urls() {
        assert!(validate_remote_url(&"file:///tmp/config.json".parse().unwrap()).is_err());
        assert!(validate_remote_url(&"http://127.0.0.1/config.json".parse().unwrap()).is_err());
        assert!(
            validate_remote_url(&"http://[::ffff:127.0.0.1]/config.json".parse().unwrap()).is_err()
        );
        assert!(validate_remote_url(&"http://localhost/config.json".parse().unwrap()).is_err());
    }
}
