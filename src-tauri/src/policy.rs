use std::{
    net::{IpAddr, ToSocketAddrs},
    time::Duration,
};

use reqwest::{Client, Url};
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
    validate_remote_url(&url)?;
    let body = fetch_bytes(url, max_bytes, resource_name).await?;
    String::from_utf8(body).map_err(|_| format!("{resource_name}不是有效的 UTF-8 文本"))
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
    validate_remote_url(&url)?;
    let client = build_http_client()?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err(format!(
            "{resource_name}响应超过 {} MB 限制",
            max_bytes / 1024 / 1024
        ));
    }
    let body = response.bytes().await.map_err(|error| error.to_string())?;
    if body.len() > max_bytes {
        return Err(format!(
            "{resource_name}响应超过 {} MB 限制",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(body.to_vec())
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
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
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
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
        assert!(validate_remote_url(&"http://localhost/config.json".parse().unwrap()).is_err());
    }
}
