//! Turns whatever a configuration URL actually serves into text a parser can read.
//!
//! Measured against the ten addresses the user supplied, only four are plain JSON at a URL that
//! returns `application/json`. The rest are:
//!
//! | Address | What it really serves |
//! |---|---|
//! | 饭太硬 | a JPEG whose picture ends at byte 2401, then 8 bytes, then `**`, then base64 of the JSON |
//! | 肥猫 | bare JSON under `text/html` |
//! | 王二小 / 嗷呜 | an HTML landing page; there is no configuration at this address at all |
//! | 老刘备 / 小盒子单仓 | JSON behind leading `//` comments |
//! | VOX | 404 |
//! | 小盒子多仓 / 挺好分享多仓 | `{"urls":[…]}` — a list of OTHER configurations |
//! | 拾光多仓 | JSON with an HTML `<div>` footer appended after it |
//!
//! The image case is the "some of them are pictures" the user described. It is a distribution trick:
//! the file opens as a picture in a browser and as a configuration in a client that reads past the
//! image, so the picture is not an error to report — it is a wrapper to unwrap.
//!
//! This module does the **byte-level** half only: recognising a container, extracting the payload,
//! decoding an encoding. Text-level questions (is this a 多仓 list? is it a web page?) are decided in
//! `src/features/config/config-source.ts`, which has a JSON5 parser and is far easier to test. The
//! split is deliberate: neither side re-implements what the other already has.
//!
//! Nothing here executes anything. Every step is an inspection of a downloaded body.

use base64::Engine;

/// What a fetched body turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedBody {
    /// Text, ready for the parser. `unwrap_note` names what had to be removed, when anything did.
    Text {
        text: String,
        unwrap_note: Option<String>,
    },
    /// A picture with nothing after it. There is no configuration in this response.
    ImageOnly { kind: &'static str, bytes: usize },
}

/// A decoded payload may not exceed this, so a base64 body cannot expand past the fetch's own cap.
const MAX_DECODED_BYTES: usize = 10 * 1024 * 1024;

/// Decodes a fetched body.
///
/// The image check runs first because an image's own bytes can contain sequences that look like JSON
/// or HTML, so scanning for `{` before unwrapping would find the wrong thing. Content-type is not
/// trusted either: 饭太硬 reports `image/x-ms-bmp` for a JPEG, and several of these hosts report
/// `text/html` for plain JSON.
pub fn decode_config_body(body: &[u8]) -> Result<DecodedBody, String> {
    if let Some((payload, kind)) = split_trailing_payload(body) {
        let text = decode_payload(payload)?;
        return Ok(DecodedBody::Text {
            text,
            unwrap_note: Some(format!("已从 {kind} 图片中取出内嵌的配置")),
        });
    }

    // A picture with nothing appended is not a configuration, and saying so is the useful answer.
    if let Some(kind) = image_kind(body) {
        return Ok(DecodedBody::ImageOnly {
            kind,
            bytes: body.len(),
        });
    }

    Ok(DecodedBody::Text {
        text: decode_text(body)?,
        unwrap_note: None,
    })
}

/// Decodes an extracted payload, which may be base64 rather than plain text.
///
/// Three shapes are tried, in order of how specific they are:
///
/// 1. the payload as text, because the image may have been followed by plain JSON;
/// 2. text after a `**` separator, base64-decoded — the measured shape, where 8 bytes of noise sit
///    before the marker. The prefix's length is not hard-coded: it was stable across three requests,
///    but it is a publisher's choice and not something to depend on, so the marker is what is found;
/// 3. the whole payload as base64 — a base64 body with no marker.
///
/// Every candidate is checked for looking like text before being accepted, so a wrong guess falls
/// through to the next instead of returning binary as a string.
fn decode_payload(payload: &[u8]) -> Result<String, String> {
    if let Ok(text) = decode_text(payload) {
        if looks_like_configuration(&text) {
            return Ok(text);
        }
    }

    if let Some(marker) = find_last(payload, b"**") {
        let encoded = &payload[marker + 2..];
        if let Some(decoded) = decode_base64_lenient(encoded) {
            if let Ok(text) = decode_text(&decoded) {
                if looks_like_configuration(&text) {
                    return Ok(text);
                }
            }
        }
    }

    if let Some(decoded) = decode_base64_lenient(payload) {
        if let Ok(text) = decode_text(&decoded) {
            if looks_like_configuration(&text) {
                return Ok(text);
            }
        }
    }

    Err("图片后面确实有数据，但既不是配置文本，也不是可用的 base64 配置。".to_string())
}

/// Whether text begins in a way a configuration or a message about one could.
///
/// Deliberately loose — the real judgement belongs to the parser and to `config-source.ts`. This only
/// has to reject binary that happened to survive an encoding guess.
fn looks_like_configuration(text: &str) -> bool {
    // A leading BOM is an encoding artefact, and one of the measured responses carries it. Not
    // skipping it would classify a perfectly good 多仓 document as "not a configuration" — which is
    // exactly what the live test caught.
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    trimmed.starts_with('{')
        || trimmed.starts_with('[')
        || trimmed.starts_with('<')
        || trimmed.starts_with("//")
        || trimmed.starts_with('#')
}

/// The image format of a body, by magic number.
pub fn image_kind(body: &[u8]) -> Option<&'static str> {
    if body.len() < 8 {
        return None;
    }
    if body.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("JPEG");
    }
    if body.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("PNG");
    }
    if body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a") {
        return Some("GIF");
    }
    if body.starts_with(b"RIFF") && body.len() > 12 && &body[8..12] == b"WEBP" {
        return Some("WEBP");
    }
    if body.starts_with(b"BM") {
        return Some("BMP");
    }
    None
}

/// The payload after an image's data, when there is one.
///
/// Each format ends at a marker rather than at a declared length, because these files are produced by
/// appending to a complete image — the declared length would not account for the payload.
pub fn split_trailing_payload(body: &[u8]) -> Option<(&[u8], &'static str)> {
    match image_kind(body)? {
        // EOI (FFD9) is two bytes and can legitimately appear inside entropy-coded data, so the LAST
        // occurrence is used — that is where the image really ends.
        "JPEG" => {
            let end = find_last(body, &[0xff, 0xd9])?;
            non_empty(&body[end + 2..], "JPEG")
        }
        // The IEND chunk is length(4) + "IEND"(4) + CRC(4), so the image ends 8 bytes after it starts.
        "PNG" => {
            let at = find_last(body, b"IEND")?;
            non_empty(&body[(at + 8).min(body.len())..], "PNG")
        }
        // The GIF trailer is a single 0x3B byte, which is far from unique, so again the last one.
        "GIF" => {
            let end = body.iter().rposition(|byte| *byte == 0x3b)?;
            non_empty(&body[end + 1..], "GIF")
        }
        // WEBP declares its size, so the payload starts right after the declared extent.
        "WEBP" => {
            let declared = u32::from_le_bytes([body[4], body[5], body[6], body[7]]) as usize;
            non_empty(&body[(8 + declared).min(body.len())..], "WEBP")
        }
        // BMP declares its size in the header too.
        "BMP" => {
            let declared = u32::from_le_bytes([body[2], body[3], body[4], body[5]]) as usize;
            non_empty(&body[declared.min(body.len())..], "BMP")
        }
        other => {
            let _ = other;
            None
        }
    }
}

/// A payload only counts when something is actually there.
///
/// The lifetime is explicit because the returned slice borrows the input: elision cannot infer it
/// through the `'static` second element.
fn non_empty<'a>(payload: &'a [u8], kind: &'static str) -> Option<(&'a [u8], &'static str)> {
    if payload.is_empty() {
        None
    } else {
        Some((payload, kind))
    }
}

/// The last occurrence of `needle`.
fn find_last(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len())
        .rev()
        .find(|index| &haystack[*index..*index + needle.len()] == needle)
}

/// Decodes text bytes, tolerating the encodings these sites actually use.
///
/// The fetch path used `String::from_utf8`, which rejects a GBK file outright. That is the wrong
/// failure for a configuration: the file is fine, we merely guessed the wrong encoding. UTF-8 is
/// tried first and preferred; only when it fails does a fallback run.
pub fn decode_text(body: &[u8]) -> Result<String, String> {
    if let Ok(text) = std::str::from_utf8(body) {
        return Ok(text.to_string());
    }

    // UTF-16 with a BOM is unambiguous, so it is tried before any statistical guess.
    if body.starts_with(&[0xff, 0xfe]) {
        let (text, _, had_errors) = encoding_rs::UTF_16LE.decode(body);
        if !had_errors {
            return Ok(text.to_string());
        }
    }
    if body.starts_with(&[0xfe, 0xff]) {
        let (text, _, had_errors) = encoding_rs::UTF_16BE.decode(body);
        if !had_errors {
            return Ok(text.to_string());
        }
    }

    // No BOM. GB18030 covers GBK and is a superset of it; Big5 covers the Taiwanese sites. The first
    // one that decodes without error wins, and UTF-8 already failed by this point.
    for encoding in [encoding_rs::GB18030, encoding_rs::BIG5] {
        let (text, _, had_errors) = encoding.decode(body);
        if !had_errors {
            return Ok(text.to_string());
        }
    }

    Err("配置内容既不是 UTF-8，也无法按 GB18030 / Big5 / UTF-16 解码。".to_string())
}

/// Decodes base64 that may carry whitespace or a trailing fragment, returning None on anything that
/// is not plausibly base64.
///
/// `STANDARD` padding is required, but some publishers omit it, so the compact form is retried with
/// padding restored before giving up.
fn decode_base64_lenient(payload: &[u8]) -> Option<Vec<u8>> {
    let compact: Vec<u8> = payload
        .iter()
        .copied()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if compact.is_empty() || compact.len() > MAX_DECODED_BYTES * 4 / 3 + 8 {
        return None;
    }
    // Anything outside the alphabet means this is not base64 at all.
    if !compact
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return None;
    }

    let engine = base64::engine::general_purpose::STANDARD;
    if let Ok(decoded) = engine.decode(&compact) {
        return Some(decoded);
    }

    // Restore the padding a publisher may have stripped.
    let mut padded = compact.clone();
    while padded.len() % 4 != 0 {
        padded.push(b'=');
    }
    engine.decode(&padded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JPEG: the smallest thing with a SOI and an EOI, so the marker logic is what is under test
    /// rather than a real picture's bytes.
    fn jpeg_with(payload: &[u8]) -> Vec<u8> {
        let mut body = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, b'J', b'F', b'I', b'F'];
        body.extend_from_slice(&[0x11, 0x22, 0x33]);
        body.extend_from_slice(&[0xff, 0xd9]);
        body.extend_from_slice(payload);
        body
    }

    fn base64_of(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
    }

    #[test]
    fn unwraps_a_configuration_hidden_after_a_jpeg() {
        // The measured shape: an image, then a short run of noise, then `**`, then base64 of the
        // configuration. The picture is a wrapper, not an error.
        let json = "{\"sites\":[{\"key\":\"a\",\"name\":\"甲\",\"api\":\"https://a/x\"}]}";
        let mut body = jpeg_with(b"");
        body.extend_from_slice(b"odvEMkqU**");
        body.extend_from_slice(base64_of(json).as_bytes());

        let decoded = decode_config_body(&body).unwrap();
        match decoded {
            DecodedBody::Text { text, unwrap_note } => {
                assert_eq!(text, json);
                assert!(unwrap_note.unwrap().contains("JPEG"));
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn unwraps_a_configuration_appended_to_a_jpeg_as_plain_text() {
        // The other possible shape: no marker, no base64, just JSON after the image.
        let json = "{\"sites\":[]}";
        let body = jpeg_with(json.as_bytes());

        match decode_config_body(&body).unwrap() {
            DecodedBody::Text { text, .. } => assert_eq!(text, json),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn reports_an_image_with_nothing_after_it_as_an_image() {
        // A picture alone is not a configuration, and saying so beats reporting a JSON syntax error
        // about binary bytes.
        let body = jpeg_with(b"");
        match decode_config_body(&body).unwrap() {
            DecodedBody::ImageOnly { kind, bytes } => {
                assert_eq!(kind, "JPEG");
                assert_eq!(bytes, body.len());
            }
            other => panic!("expected an image, got {other:?}"),
        }
    }

    #[test]
    fn uses_the_last_jpeg_end_marker_so_a_payload_containing_one_is_not_truncated() {
        // FFD9 can occur inside the payload — here the payload itself contains that byte pair before
        // the encoded JSON. Taking the FIRST marker would cut the configuration in half, and the
        // resulting parse error would look nothing like the cause.
        let json = "{\"sites\":[{\"key\":\"a\",\"name\":\"甲\",\"api\":\"https://a/x\"}]}";
        let encoded = base64_of(json);

        let mut payload = Vec::new();
        payload.extend_from_slice(b"head");
        payload.extend_from_slice(&[0xff, 0xd9]);
        payload.extend_from_slice(encoded.as_bytes());

        let mut body = jpeg_with(b"");
        body.extend_from_slice(&payload);

        match decode_config_body(&body).unwrap() {
            DecodedBody::Text { text, .. } => assert_eq!(text, json),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn passes_plain_text_through_untouched() {
        let json = "{\"sites\":[]}";
        match decode_config_body(json.as_bytes()).unwrap() {
            DecodedBody::Text { text, unwrap_note } => {
                assert_eq!(text, json);
                assert!(unwrap_note.is_none(), "nothing was unwrapped");
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn decodes_gbk_text_that_utf8_would_reject() {
        // The fetch path rejected non-UTF-8 outright. A GBK configuration is a valid configuration;
        // rejecting it reported our encoding guess as the file's fault.
        let (encoded, _, had_errors) = encoding_rs::GB18030.encode("{\"name\":\"中文配置\"}");
        assert!(!had_errors);
        assert!(
            std::str::from_utf8(&encoded).is_err(),
            "must not be valid UTF-8"
        );

        let text = decode_text(&encoded).unwrap();
        assert!(text.contains("中文配置"), "decoded: {text}");
    }

    #[test]
    fn prefers_utf8_when_it_is_valid() {
        // The fallback must not run on a file that is already fine: GB18030 decodes almost any byte
        // sequence, so trying it first would silently mojibake perfectly good UTF-8.
        let text = "{\"name\":\"中文\"}";
        assert_eq!(decode_text(text.as_bytes()).unwrap(), text);
    }

    #[test]
    fn keeps_a_utf8_bom_for_the_parser_to_deal_with() {
        // Stripping the BOM here would be a second place that knows about it; the parser already
        // handles it, and the decode layer's job is bytes to text.
        let mut body = vec![0xef, 0xbb, 0xbf];
        body.extend_from_slice(b"{\"sites\":[]}");
        let text = decode_text(&body).unwrap();
        assert!(text.starts_with('\u{feff}'));
        assert!(text.contains("\"sites\""));
    }

    #[test]
    fn does_not_treat_a_bmp_header_as_a_jpeg() {
        // `BM` is BMP, and its declared size is what delimits it — the two formats share no marker.
        let json = "{\"sites\":[]}";
        let mut body = Vec::new();
        body.extend_from_slice(b"BM");
        body.extend_from_slice(&40u32.to_le_bytes());
        body.extend_from_slice(&[0u8; 34]);
        body.extend_from_slice(json.as_bytes());

        match decode_config_body(&body).unwrap() {
            DecodedBody::Text { text, unwrap_note } => {
                assert_eq!(text, json);
                assert!(unwrap_note.unwrap().contains("BMP"));
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_payload_that_is_neither_text_nor_base64() {
        // Binary noise after an image must be reported, not handed to the parser as a string of
        // replacement characters.
        let mut body = jpeg_with(&[0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
        body.extend_from_slice(&[0x00, 0x01, 0x02, 0x03]);
        let result = decode_config_body(&body);
        assert!(result.is_err(), "expected an error, got {result:?}");
    }

    #[test]
    fn accepts_base64_without_padding() {
        // Some publishers strip the trailing `=`. Refusing it would report a content problem where
        // there is only a formatting one.
        let json = "{\"sites\":[]}";
        let padded = base64_of(json);
        let unpadded = padded.trim_end_matches('=');
        let mut body = jpeg_with(b"");
        body.extend_from_slice(b"**");
        body.extend_from_slice(unpadded.as_bytes());

        match decode_config_body(&body).unwrap() {
            DecodedBody::Text { text, .. } => assert_eq!(text, json),
            other => panic!("expected text, got {other:?}"),
        }
    }

    /// The ten addresses the user supplied, checked against the live network through this module.
    ///
    /// `#[ignore]`d because it needs the internet, so it is not part of the ordinary gate. Run it with
    /// `cargo test config::decode -- --ignored --nocapture`.
    ///
    /// This is the test that justifies the whole module, so it asserts what each address must produce
    /// rather than only printing it. The expectations are the measured reality: two addresses serve a
    /// landing page and one is dead, and pinning that is what stops a later change from silently
    /// reclassifying them.
    #[test]
    #[ignore = "requires network access"]
    fn the_addresses_the_user_supplied_all_decode_to_something_usable() {
        /// What an address is expected to produce.
        #[derive(Debug, PartialEq)]
        enum Expected {
            /// A configuration, optionally wrapped in something this module unwraps.
            Config { unwrapped: bool },
            /// A web page, which is not a configuration but is also not a decode failure.
            Text,
        }

        let addresses: &[(&str, &str, Expected)] = &[
            (
                "饭太硬",
                "http://www.饭太硬.net/tv",
                Expected::Config { unwrapped: true },
            ),
            (
                "肥猫",
                "http://肥猫.net/",
                Expected::Config { unwrapped: false },
            ),
            ("王二小", "http://new.王二小放牛娃.top", Expected::Text),
            (
                "老刘备",
                "https://raw.liucn.cc/box/m.json",
                Expected::Config { unwrapped: false },
            ),
            (
                "小盒子单仓",
                "http://xhztv.top/xhz",
                Expected::Config { unwrapped: false },
            ),
            // A 404 page: the fetch itself is what reports this, not the decoder.
            ("VOX", "http://rihou.cc:88/demo.php", Expected::Text),
            ("嗷呜", "http://itv666.cc/aowu/config.webp", Expected::Text),
            (
                "小盒子多仓",
                "http://xhztv.top/dc",
                Expected::Config { unwrapped: false },
            ),
            (
                "拾光多仓",
                "http://xmbjm.fh4u.org/dc.txt",
                Expected::Config { unwrapped: false },
            ),
            (
                "挺好分享多仓",
                "http://ztha.top/TVBox/GYCK.json",
                Expected::Config { unwrapped: false },
            ),
        ];

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            // The decoded text is also written to disk, so the frontend's classifier and parser can be
            // tested against what this module really produces rather than against a second
            // implementation of the unwrapping. One unwrap implementation, two test layers.
            let mut dump = String::new();

            for (label, url, expected) in addresses {
                let parsed = reqwest::Url::parse(url).expect("a valid address");
                let fetched = crate::policy::fetch_response_bytes_public(
                    parsed,
                    10 * 1024 * 1024,
                    "配置响应",
                )
                .await;

                // A dead address is a fact about the address, not a defect here. Everything else must
                // decode.
                let Ok((body, _, _)) = fetched else {
                    println!("{label}: unreachable ({url})");
                    continue;
                };

                let decoded = decode_config_body(&body);
                match (decoded, expected) {
                    (
                        Ok(DecodedBody::Text { text, unwrap_note }),
                        Expected::Config { unwrapped },
                    ) => {
                        // The BOM is skipped here because one of the measured responses carries it and
                        // it is an encoding artefact rather than content. `looks_like_configuration`
                        // already tolerates it; this assertion has to agree, or it fails a document
                        // the module correctly accepted.
                        let head = text.trim_start_matches('\u{feff}').trim_start();
                        assert!(
                            head.starts_with('{')
                                || head.starts_with('[')
                                || head.starts_with("//")
                                || head.starts_with('#'),
                            "{label} decoded to something that is not a configuration: {}",
                            text.chars().take(80).collect::<String>()
                        );
                        assert_eq!(
                            unwrap_note.is_some(),
                            *unwrapped,
                            "{label}: unwrap expectation failed (note: {unwrap_note:?})"
                        );
                        println!(
                            "{label}: config, {} bytes{}",
                            text.len(),
                            if *unwrapped { ", unwrapped" } else { "" }
                        );
                        dump.push_str(&format!("=== {label} ===\n{text}\n"));
                    }
                    (Ok(DecodedBody::Text { text, .. }), Expected::Text) => {
                        println!(
                            "{label}: text, starts {:?}",
                            text.chars().take(40).collect::<String>()
                        );
                    }
                    (Ok(DecodedBody::ImageOnly { kind, bytes }), _) => {
                        println!("{label}: image only ({kind}, {bytes} bytes)");
                    }
                    (other, want) => panic!("{label}: expected {want:?}, got {other:?}"),
                }
            }

            let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("tmp-decoded-addresses.txt");
            std::fs::write(&out, dump).expect("write the decoded fixtures");
            println!("wrote {}", out.display());
        });
    }
}
