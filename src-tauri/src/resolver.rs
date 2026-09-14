use serde::Serialize;

use crate::policy::validate_remote_url;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackResolution {
    pub url: String,
    pub media_kind: String,
    pub adapter_id: String,
}

#[tauri::command]
pub fn resolve_playback(url: String) -> Result<PlaybackResolution, String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    validate_remote_url(&parsed_url)?;
    let lower_url = url.to_ascii_lowercase();
    let media_kind = if lower_url.contains(".m3u8") {
        "hls"
    } else if lower_url.contains(".mp4") {
        "mp4"
    } else {
        "unknown"
    };
    Ok(PlaybackResolution {
        url,
        media_kind: media_kind.to_string(),
        adapter_id: "direct-http".to_string(),
    })
}
