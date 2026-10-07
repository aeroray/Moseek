use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::Url;
use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

use crate::policy::fetch_media_bytes;

/// A poster is a single image, so this is generous rather than tight. The limit exists to stop a
/// mislabelled address from streaming something enormous into memory before it is written.
const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub path: String,
    pub bytes: usize,
}

/// Downloads an image and writes it wherever the user chooses.
///
/// The whole operation lives on the Rust side — fetch, ask, write — rather than exposing a
/// download plus a separate filesystem write to the webview. That keeps one capability surface
/// instead of two, and means the bytes never have to travel through the IPC boundary just to be
/// handed straight back for writing.
///
/// The address goes through the same policy as every other request, so this cannot be used to
/// reach the local network. That matters more here than elsewhere: the URL comes from a source
/// the user imported, not from the app itself.
///
/// Returning `Ok(None)` means the user dismissed the dialog, which is an ordinary outcome and not
/// an error worth reporting as one.
#[tauri::command]
pub async fn download_image(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
) -> Result<Option<SavedImage>, String> {
    let parsed = Url::parse(&url).map_err(|error| error.to_string())?;
    let (body, content_type, _) =
        fetch_media_bytes(parsed, MAX_IMAGE_BYTES, "海报图片", &[]).await?;
    if body.is_empty() {
        return Err("图片内容为空，无法保存。".to_string());
    }

    let suggested = suggested_file_name(&file_name, content_type.as_deref(), &url);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("保存图片")
        .set_file_name(&suggested)
        .add_filter("图片", &["jpg", "jpeg", "png", "webp", "gif", "avif"])
        .save_file(move |path| {
            // A send failure only means the command was already cancelled; there is nothing to do
            // about it and nothing worth reporting.
            let _ = sender.send(path);
        });

    let chosen = receiver
        .await
        .map_err(|_| "保存对话框未能返回结果。".to_string())?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path: PathBuf = chosen
        .into_path()
        .map_err(|error| format!("无法解析所选保存位置：{error}"))?;

    let bytes = body.len();
    std::fs::write(&path, &body).map_err(|error| format!("写入文件失败：{error}"))?;

    Ok(Some(SavedImage {
        path: path.to_string_lossy().into_owned(),
        bytes,
    }))
}

/// Builds a usable file name from the work's title.
///
/// Titles are user- and provider-supplied, so they routinely contain characters Windows forbids
/// in a path (`:`, `?`, `/`, `*`) and can carry a full-width colon that looks harmless but is not
/// the one the filesystem rejects. Everything outside a conservative set is replaced rather than
/// stripped, so two different titles cannot collapse onto the same name and silently overwrite
/// one another.
pub(crate) fn suggested_file_name(title: &str, content_type: Option<&str>, url: &str) -> String {
    let mut cleaned = String::with_capacity(title.len());
    for character in title.chars() {
        let forbidden = matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        ) || character.is_control();
        // Full-width and CJK punctuation that Windows rejects or that reads as a path separator.
        let lookalike = matches!(
            character,
            '：' | '？' | '＊' | '｜' | '／' | '＼' | '＜' | '＞'
        );
        if forbidden || lookalike {
            cleaned.push('_');
        } else {
            cleaned.push(character);
        }
    }
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    let stem = if cleaned.is_empty() {
        "poster"
    } else {
        cleaned
    };
    // Windows caps a path segment at 255 characters, and the extension has to fit inside it.
    let stem: String = stem.chars().take(120).collect();

    format!("{stem}{}", image_extension(content_type, url))
}

/// Chooses an extension from the response first and the address second.
///
/// The content type is the better evidence — a CDN often serves an image from a path with no
/// extension at all — but it is also sometimes absent, so the URL is the fallback. The default is
/// `.jpg` because it is what a mislabelled image almost always turns out to be.
fn image_extension(content_type: Option<&str>, url: &str) -> &'static str {
    let from_content_type = content_type.map(|value| {
        let value = value.to_ascii_lowercase();
        if value.contains("png") {
            Some(".png")
        } else if value.contains("webp") {
            Some(".webp")
        } else if value.contains("gif") {
            Some(".gif")
        } else if value.contains("avif") {
            Some(".avif")
        } else if value.contains("jpeg") || value.contains("jpg") {
            Some(".jpg")
        } else {
            None
        }
    });
    if let Some(Some(extension)) = from_content_type {
        return extension;
    }

    let lowered = url.to_ascii_lowercase();
    for (needle, extension) in [
        (".png", ".png"),
        (".webp", ".webp"),
        (".gif", ".gif"),
        (".avif", ".avif"),
        (".jpeg", ".jpg"),
        (".jpg", ".jpg"),
    ] {
        if lowered.contains(needle) {
            return extension;
        }
    }
    ".jpg"
}

/// Decodes an image that arrived as a data URL.
///
/// Used only by tests today, but kept beside the naming rules so the two stay in step: a data URL
/// has no extension of its own, and this is the other place a poster can come from.
#[allow(dead_code)]
pub(crate) fn decode_data_url(value: &str) -> Option<Vec<u8>> {
    let (_, payload) = value.split_once("base64,")?;
    BASE64.decode(payload.trim()).ok()
}

#[cfg(test)]
mod tests {
    use super::{image_extension, suggested_file_name};

    #[test]
    fn titles_that_are_illegal_paths_become_usable_names() {
        // Providers put colons and question marks in titles, and Windows rejects both outright.
        assert_eq!(
            suggested_file_name("冬城猎凶：第一季", Some("image/jpeg"), "https://x/a"),
            "冬城猎凶_第一季.jpg"
        );
        assert_eq!(
            suggested_file_name("What?", None, "https://x/a.png"),
            "What_.png"
        );
        assert_eq!(
            suggested_file_name("a/b\\c", None, "https://x/a"),
            "a_b_c.jpg"
        );
    }

    #[test]
    fn an_empty_title_still_produces_a_file() {
        // A blank title must not produce a bare extension, which the dialog would reject.
        assert_eq!(
            suggested_file_name("   ", None, "https://x/a"),
            "poster.jpg"
        );
        assert_eq!(suggested_file_name("", None, "https://x/a"), "poster.jpg");
    }

    #[test]
    fn the_content_type_outranks_the_address() {
        // A CDN commonly serves a real image from an extension-less path, so the header is the
        // better evidence when the two disagree.
        assert_eq!(
            image_extension(Some("image/webp"), "https://x/a.jpg"),
            ".webp"
        );
        assert_eq!(image_extension(None, "https://x/a.webp"), ".webp");
        assert_eq!(image_extension(None, "https://x/no-extension"), ".jpg");
        // A content type that says nothing useful must not win over a usable address.
        assert_eq!(
            image_extension(Some("application/octet-stream"), "https://x/a.png"),
            ".png"
        );
    }

    #[test]
    fn a_long_title_is_trimmed_to_fit_a_path_segment() {
        // Windows caps a single path segment; an untrimmed title would fail at write time.
        let name = suggested_file_name(&"长".repeat(400), None, "https://x/a");
        assert!(
            name.chars().count() <= 124,
            "{} chars",
            name.chars().count()
        );
        assert!(name.ends_with(".jpg"));
    }

    #[test]
    fn a_trailing_dot_is_removed() {
        // Windows silently drops a trailing dot, so the extension would be lost.
        assert_eq!(
            suggested_file_name("名字.", None, "https://x/a"),
            "名字.jpg"
        );
    }
}
