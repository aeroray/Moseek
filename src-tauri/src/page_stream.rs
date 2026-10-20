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

use std::collections::HashSet;

use reqwest::Url;

use crate::policy::validate_remote_url;

/// Media extensions that identify a URL the player can actually open.
///
/// `.m3u8` and `.mp4` are what the player handles; `.flv` appears in older sources and is kept so
/// it can be reported as a found-but-unsupported address rather than silently missed.
pub(crate) const MEDIA_EXTENSIONS: [&str; 3] = [".m3u8", ".mp4", ".flv"];

/// How many addresses one scan may return.
///
/// Neither caller reads past the head: the resolver takes `media.first()`, and the XBPQ adapter gives
/// one address per play line out of a page whose line count is a few dozen. Pages, however, can carry
/// tens of thousands of distinct addresses — 50 462 in one measured 1 MiB page — and every one of
/// them was resolved, allocated and pushed before the caller discarded all but the first. A cap keeps
/// the cost proportional to what is used rather than to what an upstream chose to send.
const MAX_SCANNED_URLS: usize = 64;

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
    if value.is_empty() {
        return None;
    }
    // No `starts_with("javascript:")` / `starts_with("data:")` here. `Url::join` lowercases the
    // scheme, so a case-sensitive prefix test let `JAVASCRIPT:alert(1)` — and the same value with a
    // leading space — through to the join: the guard expressed an intent it did not enforce. The
    // scheme decision belongs in one place, and `validate_remote_url` already makes it for
    // http/https only. Three copies of the guard existed; they are gone, not reimplemented.
    let url = base_url.join(value).ok()?;
    validate_remote_url(&url).ok()?;
    Some(url)
}

/// Every media address embedded in a page, in the order it appears, de-duplicated.
///
/// Relative addresses are resolved against the page, because both real shapes use them:
/// `var main = "/2022…/index.m3u8?sign=…"` and an absolute `https://…/index.m3u8`.
pub(crate) fn media_urls_in_page(html: &str, base_url: &Url) -> Vec<String> {
    // A set for membership, the vector for order. `Vec::contains` was a linear scan per address, so
    // the whole scan was quadratic: measured 2.40 s for a 1 MiB page of distinct `.m3u8` addresses
    // (50 462 of them) and 14.16 s for 2 MiB. The input is the remote page's own body.
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for candidate in candidate_urls(html) {
        if out.len() >= MAX_SCANNED_URLS {
            break;
        }
        if !is_media_url(&candidate) {
            continue;
        }
        if let Some(url) = resolve_candidate(base_url, &candidate) {
            let url = url.to_string();
            if seen.insert(url.clone()) {
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
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for candidate in candidate_urls(html) {
        if out.len() >= MAX_SCANNED_URLS {
            break;
        }
        let lowered = candidate.to_ascii_lowercase();
        if !tokens.iter().any(|token| lowered.contains(token.as_str())) {
            continue;
        }
        if let Some(url) = resolve_candidate(base_url, &candidate) {
            let url = url.to_string();
            if seen.insert(url.clone()) {
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
    let mut seen: HashSet<String> = HashSet::new();
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
                // The same set-not-vector rule as the media scanners: a hostile page can carry
                // thousands of frames, and the linear scan made collecting them quadratic.
                if seen.insert(url.clone()) {
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
        let found = iframe_urls_in_page(
            html,
            &"https://www.dora-video.cn/archives/192/".parse().unwrap(),
        );
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
        let found = media_urls_in_page(
            html,
            &"https://play.hhuus.com/play/epYkgmma".parse().unwrap(),
        );
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
        assert_eq!(found, vec!["https://cdn.example/a/index.m3u8".to_string()]);
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

    /// A hostile page must not make the scan quadratic, and the result must stay bounded.
    ///
    /// `Vec::contains` made de-duplication a linear scan per address: measured 2.40 s for a 1 MiB
    /// page carrying 50 462 distinct `.m3u8` addresses and 14.16 s for 2 MiB. The input is the remote
    /// page's own body, and the resolver pays that cost on every episode the user opens. The set
    /// makes the scan linear, and `MAX_SCANNED_URLS` stops collecting at the point where nothing
    /// further can be read — the resolver takes only the first address.
    #[test]
    fn a_megabyte_of_distinct_addresses_stays_bounded_and_fast() {
        // Exactly the measured shape: one quoted, distinct media address per line.
        let mut html = String::with_capacity(1024 * 1024 + 64);
        let mut index = 0usize;
        while html.len() < 1024 * 1024 {
            html.push_str(&format!(
                "var u{index} = \"https://cdn.example/{index}/index.m3u8\";\n"
            ));
            index += 1;
        }
        assert!(index > 20_000, "the fixture must be the hostile shape");

        let started = std::time::Instant::now();
        let found = media_urls_in_page(&html, &base());
        let elapsed = started.elapsed();

        assert_eq!(
            found.len(),
            super::MAX_SCANNED_URLS,
            "the scan stops at the number of addresses a caller can use"
        );
        // Generous by three orders of magnitude against the 2.4 s the linear scan took, so this
        // fails on a reintroduced quadratic rather than on a slow machine.
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "1 MiB scan took {elapsed:?}; a linear scan measures in single-digit milliseconds"
        );
        // Order is still document order, which is what makes the first address the right one.
        assert_eq!(found[0], "https://cdn.example/0/index.m3u8");
        assert_eq!(found[1], "https://cdn.example/1/index.m3u8");
    }

    /// The same bound applies to the token-filtered scanner the XBPQ adapter uses.
    #[test]
    fn the_token_filtered_scan_is_also_bounded() {
        let mut html = String::with_capacity(256 * 1024);
        for index in 0..5_000 {
            html.push_str(&format!(
                "const u{index} = \"https://cdn.example/{index}/index.m3u8\";\n"
            ));
        }
        let found = media_urls_matching(&html, &base(), &[".m3u8".to_string()]);

        assert_eq!(found.len(), super::MAX_SCANNED_URLS);
        assert_eq!(found[0], "https://cdn.example/0/index.m3u8");
    }

    /// The scheme guard does not depend on the value's spelling.
    ///
    /// The removed guard was `starts_with("javascript:")`, which `Url::join` defeats because it
    /// lowercases the scheme: measured, `JAVASCRIPT:alert(1)` and `"  javascript:alert(1)"` both got
    /// past it and joined as `javascript:`. `validate_remote_url` refuses the scheme regardless of
    /// case and leading whitespace, so all three spellings must be refused.
    #[test]
    fn refuses_non_http_schemes_regardless_of_their_spelling() {
        let html = r#"
            var a = "JAVASCRIPT:alert(1)";
            var b = "DATA:text/html,<script>alert(1)</script>";
            var c = "Javascript:alert(1)";
        "#;
        assert!(media_urls_in_page(html, &base()).is_empty());

        // A direct call too: this is the function the three former copies guarded.
        assert!(super::resolve_candidate(&base(), "JAVASCRIPT:alert(1)").is_none());
        assert!(super::resolve_candidate(&base(), "  javascript:alert(1)").is_none());
        assert!(super::resolve_candidate(&base(), "data:text/html,x").is_none());
    }
}
