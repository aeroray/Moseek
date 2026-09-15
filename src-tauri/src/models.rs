use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub(crate) struct AppDatabase(pub(crate) Mutex<Connection>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub key: String,
    pub name: String,
    pub source_type: String,
    #[serde(default)]
    pub script_archive_id: Option<i64>,
    #[serde(default)]
    pub source_dialect: Option<String>,
    pub site_type: Option<i64>,
    pub site_protocol: Option<String>,
    pub api: String,
    #[serde(default)]
    pub logo: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub nsfw: bool,
    #[serde(default = "default_true")]
    pub status: bool,
    pub ext: Option<String>,
    #[serde(default)]
    pub extra: Option<String>,
    pub jar: Option<String>,
    pub epg: Option<String>,
    pub searchable: bool,
    pub filterable: bool,
    pub capability: String,
    pub capability_note: String,
    #[serde(default)]
    pub test_status: Option<String>,
    #[serde(default)]
    pub test_message: Option<String>,
    #[serde(default)]
    pub tested_at: Option<String>,
    #[serde(default)]
    pub test_item_count: Option<u64>,
    #[serde(default)]
    pub test_category_count: Option<u64>,
    #[serde(default)]
    pub test_duration_ms: Option<u64>,
    #[serde(default)]
    pub test_operations: Vec<SourceOperationResult>,
    pub enabled: bool,
    pub last_checked_at: String,
    pub request_count: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOperationResult {
    pub operation: String,
    pub status: String,
    pub message: String,
    pub duration_ms: u64,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConfigDocumentInput {
    pub name: String,
    pub raw_config: String,
    pub normalized_config: String,
    pub sources: Vec<SourceRecord>,
    pub live_count: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocumentSummary {
    pub id: i64,
    pub name: String,
    pub source_count: i64,
    pub live_count: i64,
    pub imported_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub id: i64,
    pub name: String,
    pub raw_config: String,
    pub normalized_config: String,
    pub sources: Vec<SourceRecord>,
    pub source_count: i64,
    pub live_count: i64,
    pub imported_at: String,
}
