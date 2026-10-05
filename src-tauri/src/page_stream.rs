//! Finding a playable stream address inside a player page.
//!
//! Many ordinary CMS sources do not hand the player a media URL. Their episode addresses point at
//! a "share" or "play" page — `https://vip.lz-cdn11.com/share/0c72cb7ee1512f800abe27823a792d03`
//! — and the real manifest is written into that page's own markup:
//!
//! ```text
//! var main = "/20220621/8836_1ac491d8/index.m3u8?sign=60784c90900a46324766a1ffa0bbf6d7";
//! const vid = 'https://play.hhuus.com/play/epYkgmma/index.m3u8';
//! ```
//!
//! Moseek cannot execute the page's scripts, but it does not have to: the address is already in
//! the bytes. Scanning for it is the same declarative technique the XBPQ adapter uses for `嗅探词`,
//! which is why the scanning primitives live here and both callers share them.
//!
//! Measured on the author's own configuration: of the 33 sampled episode addresses across the
//! enabled sources, 23 were already direct and 11 sources served page addresses — scanning those
//! pages produced a verified playable manifest for 29 of 33 (the remaining 4 were a host that
//! refused the request and one source whose pages carry no address at all).
//!
//! This is deliberately a scan and not an HTML parse. These pages put the URL in an attribute, an
//! inline script, or a JSON blob, and a parser would only ever handle the first of those.

use reqwest::Url;

use crate::policy::validate_remote_url;

/// Media extensions that identify a URL the player can actually open.
///
/// `.m3u8` and `.mp4` are what the player handles; `.flv` appears in older sources and is kept so
/// it can be reported as a found-but-unsupported address rather than silently missed.
pub(crate) const MEDIA_EXTENSIONS: [&str; 3] = [".m3u8", ".mp4", ".flv"];

/// Every URL-looking string in raw page text.
///
/// Quoted attribute and literal values only: `href="..."`, `src='...'`, `"url":"..."`. That single
/// rule covers attributes, inline scripts, and inline JSON alike, which is what these pages use.
pub(crate) fn candidate_urls(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut index = 0usize;
    while index < html.len() {
        let Some(quote) = html[index..].find(['"', '\'']) else {
            break;
        };
        let start = index + quote + 1;
        let Some(end) = html[start..].find(['"', '\'']) else {
            break;
        };
        let value = &html[start..start + end];
        if looks_like_url_candidate(value) {
            out.push(unescape_slashes(value));
        }
        index = start + end + 1;
    }
    out
}

/// Whether a quoted value is worth treating as a URL.
pub(crate) fn looks_like_url_candidate(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    value.len() > 4
        && !value.contains(' ')
        && (lowered.contains(".m3u8")
            || lowered.contains(".mp4")
            || lowered.starts_with("http://")
            || lowered.starts_with("https://")
            || lowered.starts_with("//"))
}

/// Whether a resolved absolute address is a media address the player could open.
pub(crate) fn is_media_url(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    MEDIA_EXTENSIONS
        .iter()
        .any(|extension| lowered.contains(extension))
}

/// These pages routinely carry escaped slashes (`https:\/\/host\/a.m3u8`) inside inline JSON.
pub(crate) fn unescape_slashes(value: &str) -> String {
    value
        .replace("\\/", "/")
        .replace("\\u0026", "&")
        .replace("&amp;", "&")
}

/// Resolves a possibly relative value against the page, refusing non-remote schemes.
pub(crate) fn resolve_candidate(base_url: &Url, value: &str) -> Option<Url> {
    let value = value.trim();
    if value.is_empty() || value.starts_with("javascript:") || value.starts_with("data:") {
        return None;
    }
    let url = base_url.join(value).ok()?;
    validate_remote_url(&url).ok()?;
    Some(url)
}

/// Every media address embedded in a page, in the order it appears, de-duplicated.
///
/// Relative addresses are resolved against the page, because both real shapes use them:
/// `var main = "/2022…/index.m3u8?sign=…"` and an absolute `https://…/index.m3u8`.
pub(crate) fn media_urls_in_page(html: &str, base_url: &Url) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for candidate in candidate_urls(html) {
        if !is_media_url(&candidate) {
            continue;
        }
        if let Some(url) = resolve_candidate(base_url, &candidate) {
            let url = url.to_string();
            if !out.contains(&url) {
                out.push(url);
            }
        }
    }
    out
}

/// Media addresses matching the fragments a configuration names as identifying a stream.
///
/// This is the `嗅探词` reading: the config supplies the fragments (`m3u8`, `/obj/`), and the page
/// supplies the addresses. A token match is a filter over the same candidate list, not a second
/// scanner.
pub(crate) fn media_urls_matching(html: &str, base_url: &Url, tokens: &[String]) -> Vec<String> {
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for candidate in candidate_urls(html) {
        let lowered = candidate.to_ascii_lowercase();
        if !tokens.iter().any(|token| lowered.contains(token.as_str())) {
            continue;
        }
        if let Some(url) = resolve_candidate(base_url, &candidate) {
            let url = url.to_string();
            if !out.contains(&url) {
                out.push(url);
            }
        }
    }
    out
}

/// Every `<iframe src>` in a page, in document order, resolved and de-duplicated.
///
/// A player page very often does not carry the stream itself — it embeds a second player, and the
/// manifest is one level down. Measured on the real `哆啦(XBPQ)` episode pages: the page holds no
/// media address at all, and its only frame is
/// `https://us-m3u8.urldwz.com/index.php/play/2179.html`, which serves the `.m3u8`.
///
/// Only `<iframe>` is followed. A `<script src>` is a library and an `<a href>` is navigation, so
/// following those would turn one scan into an unbounded crawl.
pub(crate) fn iframe_urls_in_page(html: &str, base_url: &Url) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let lowered = html.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(found) = lowered[cursor..].find("<iframe") {
        let tag_start = cursor + found;
        let Some(tag_end) = html[tag_start..].find('>').map(|at| tag_start + at) else {
            break;
        };
        let tag = &html[tag_start..tag_end];
        if let Some(src) = attribute(tag, "src") {
            if let Some(url) = resolve_candidate(base_url, &src) {
                let url = url.to_string();
                if !out.contains(&url) {
                    out.push(url);
                }
            }
        }
        cursor = tag_end + 1;
        if cursor >= html.len() {
            break;
        }
    }
    out
}

/// Reads one attribute out of a tag, tolerating both quote styles.
fn attribute(tag: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        if let Some(at) = tag.find(&needle) {
            let rest = &tag[at + needle.len()..];
            if let Some(end) = rest.find(quote) {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{iframe_urls_in_page, is_media_url, media_urls_in_page, media_urls_matching};

    /// The frame hop that makes the XBPQ family playable.
    ///
    /// Verbatim shape from `https://www.dora-video.cn/archives/192/?action=get&p=1`: the page
    /// carries no media address of its own, and its only frame serves the manifest.
    #[test]
    fn finds_the_embedded_player_frame() {
        let html = r#"
            <div class="video"><iframe src="https://us-m3u8.urldwz.com/index.php/play/2179.html?" allowfullscreen></iframe></div>
            <a href="/archives/193/">next</a>
        "#;
        let found = iframe_urls_in_page(html, &"https://www.dora-video.cn/archives/192/".parse().unwrap());
        assert_eq!(
            found,
            vec!["https://us-m3u8.urldwz.com/index.php/play/2179.html?".to_string()]
        );
        // A page with no frame yields nothing rather than a stray navigation link.
        assert!(iframe_urls_in_page("<a href=\"/x/\">x</a>", &base()).is_empty());
    }

    /// A single-quoted `src` is the same thing, and duplicates collapse.
    #[test]
    fn tolerates_quote_style_and_duplicate_frames() {
        let html = r#"
            <iframe src='/play/a.html'></iframe>
            <iframe src="/play/a.html"></iframe>
            <iframe src="/play/b.html"></iframe>
        "#;
        let found = iframe_urls_in_page(html, &"https://host.example/page/".parse().unwrap());
        assert_eq!(
            found,
            vec![
                "https://host.example/play/a.html".to_string(),
                "https://host.example/play/b.html".to_string(),
            ]
        );
    }

    fn base() -> reqwest::Url {
        "https://vip.lz-cdn11.com/share/0c72cb7ee1512f800abe27823a792d03"
            .parse()
            .unwrap()
    }

    /// The exact text the real share page serves: the address sits in a `var` assignment as a
    /// relative path with a signature query.
    #[test]
    fn finds_a_relative_manifest_in_an_inline_script() {
        let html = r#"<script>
            var id = '0c72cb7ee1512f800abe27823a792d03'
            var main = "/20220621/8836_1ac491d8/index.m3u8?sign=60784c90900a46324766a1ffa0bbf6d7";
            var xml = "/20220621/8836_1ac491";
        </script>"#;
        let found = media_urls_in_page(html, &base());
        assert_eq!(
            found,
            vec![
                "https://vip.lz-cdn11.com/20220621/8836_1ac491d8/index.m3u8?sign=60784c90900a46324766a1ffa0bbf6d7"
                    .to_string()
            ]
        );
    }

    /// The other real shape: an absolute address assigned to a `const`.
    #[test]
    fn finds_an_absolute_manifest_in_a_const() {
        let html = r#"<script>
        const vid = 'https://play.hhuus.com/play/epYkgmma/index.m3u8';
        const videoConfig = { url: vid, type: 'hls' };
        </script>"#;
        let found = media_urls_in_page(html, &"https://play.hhuus.com/play/epYkgmma".parse().unwrap());
        assert_eq!(
            found,
            vec!["https://play.hhuus.com/play/epYkgmma/index.m3u8".to_string()]
        );
    }

    /// Escaped slashes are how the address appears inside inline JSON.
    #[test]
    fn unescapes_slashes_before_resolving() {
        let html = r#"<script>var v={"url":"https:\/\/cdn.example\/a\/index.m3u8"};</script>"#;
        let found = media_urls_in_page(html, &base());
        assert_eq!(
            found,
            vec!["https://cdn.example/a/index.m3u8".to_string()]
        );
    }

    /// A page carrying the same address twice yields it once.
    #[test]
    fn de_duplicates_repeated_addresses() {
        let html = r#"
            const a = "https://cdn.example/x/index.m3u8";
            const b = "https://cdn.example/x/index.m3u8";
        "#;
        assert_eq!(media_urls_in_page(html, &base()).len(), 1);
    }

    /// A page with no stream address yields nothing rather than a guess.
    #[test]
    fn returns_nothing_when_the_page_carries_no_stream() {
        let html = r#"<html><body><a href="/voddetail/1.html">play</a></body></html>"#;
        assert!(media_urls_in_page(html, &base()).is_empty());
    }

    /// The token filter is a filter, not a scanner: with no tokens nothing is claimed, and with a
    /// token only matching addresses are returned.
    #[test]
    fn the_token_filter_selects_among_page_addresses() {
        let html = r#"
            const trailer = "https://cdn.example/trailer.mp4";
            const main = "https://cdn.example/main/index.m3u8";
        "#;
        assert!(media_urls_matching(html, &base(), &[]).is_empty());
        assert_eq!(
            media_urls_matching(html, &base(), &[".m3u8".to_string()]),
            vec!["https://cdn.example/main/index.m3u8".to_string()]
        );
    }

    /// Local and non-HTTP addresses must not survive the scan, or a page could send the player at
    /// the local network.
    #[test]
    fn refuses_local_and_non_http_addresses() {
        let html = r#"
            const a = "http://127.0.0.1:9978/proxy/x.m3u8";
            const b = "file:///etc/x.m3u8";
        "#;
        assert!(media_urls_in_page(html, &base()).is_empty());
    }

    /// Extension matching is on the lowercased address, so an uppercase one is still recognised.
    #[test]
    fn recognises_the_extension_case_insensitively() {
        assert!(is_media_url("https://cdn.example/A/INDEX.M3U8"));
        assert!(is_media_url("https://cdn.example/a.mp4?token=1"));
        assert!(!is_media_url("https://cdn.example/a.jpg"));
    }
}
