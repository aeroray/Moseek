//! Resolving a script address that its own host refuses to serve.
//!
//! Measured on the author's configuration, 56 sources depend on a remote script and 9 of their 10
//! distinct addresses are unusable — but not all for the same reason. Two of them answer **403**
//! rather than 404: `jihulab.com` (a GitLab instance) refuses to serve raw files to anything that
//! does not look like its own web page, while the same repository is public on GitHub and serves the
//! identical file. Reporting those two as "the script is gone" is wrong, and so is leaving the
//! address unusable when a deterministic rewrite reaches it.
//!
//! **The rewrite is a fixed, named mapping, not a general proxy.** Only a host we know mirrors
//! another host is rewritten, and only in the direction we have verified. Anything else is left
//! exactly as the configuration wrote it: this module must never become a way to make an arbitrary
//! address fetchable, because the address comes from a file the user imported from a third party.

/// A verified mirror relationship between two hosts.
struct Mirror {
    /// The host as the configuration writes it.
    from_host: &'static str,
    /// The path prefix that identifies this host's raw-file form.
    from_prefix: &'static str,
    /// The host that serves the same content.
    to_host: &'static str,
}

/// The mirrors we rewrite, each verified by fetching both sides.
///
/// `jihulab.com/<owner>/<repo>/-/raw/<ref>/<path>` and
/// `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` name the same file in the same
/// repository; the only difference is the `/-/raw/` marker GitLab inserts. Verified for both
/// jihulab addresses in the author's configuration: the GitLab side answers 403 and the GitHub side
/// answers 200 with a 38 KiB script.
const MIRRORS: &[Mirror] = &[Mirror {
    from_host: "jihulab.com",
    from_prefix: "/-/raw/",
    to_host: "raw.githubusercontent.com",
}];

/// A candidate address worth trying when the configured one fails.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MirrorCandidate {
    pub url: String,
    /// Why this address is being tried, in the words the interface shows.
    pub reason: String,
}

/// Rewrites a configured address to its mirror, when we know one.
///
/// Returns `None` for every address that is not a known mirror, including any address whose shape
/// does not match exactly. A near-miss must not be guessed at: a wrong rewrite would fetch an
/// unrelated file and run it as a script.
pub(crate) fn mirror_candidate(api: &str) -> Option<MirrorCandidate> {
    let url = reqwest::Url::parse(api.trim()).ok()?;
    if url.scheme() != "https" {
        // Only https, so a rewrite cannot be used to reach a plaintext endpoint.
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    let mirror = MIRRORS.iter().find(|mirror| mirror.from_host == host)?;

    // The path must carry the mirror marker; without it this is not the shape we verified.
    let path = url.path();
    let marker = path.find(mirror.from_prefix)?;
    let (owner_repo, rest) = path.split_at(marker);
    // `/-/raw/<ref>/<file…>` — a ref and at least one path segment.
    let rest = &rest[mirror.from_prefix.len()..];
    let mut segments = rest.splitn(2, '/');
    let reference = segments.next().unwrap_or_default();
    let file = segments.next().unwrap_or_default();
    // `owner/repo` must be exactly two non-empty segments.
    let owner_repo = owner_repo.trim_matches('/');
    let mut parts = owner_repo.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if owner.is_empty()
        || repo.is_empty()
        || parts.next().is_some()
        || reference.is_empty()
        || file.is_empty()
    {
        return None;
    }

    Some(MirrorCandidate {
        url: format!("https://{}/{owner}/{repo}/{reference}/{file}", mirror.to_host),
        reason: format!(
            "{} 拒绝直接读取该文件，同一份文件在 {} 上可以读取",
            mirror.from_host, mirror.to_host
        ),
    })
}

/// How an address probe ended, in the words the interface shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProbeVerdict {
    /// The address serves a script.
    Reachable,
    /// The host answered, but refuses to serve this file.
    Refused,
    /// The file is not there.
    Missing,
    /// The host could not be reached at all.
    Unreachable,
}

impl ProbeVerdict {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Reachable => "reachable",
            Self::Refused => "refused",
            Self::Missing => "missing",
            Self::Unreachable => "unreachable",
        }
    }

    /// Classifies an HTTP status.
    ///
    /// **403 and 404 are different answers and must not be merged.** 403 means the file may well
    /// exist and the host is refusing this client — which is what a mirror can fix. 404 means the
    /// file is gone, and no rewrite will bring it back. Reporting both as "missing" is what made the
    /// two jihulab sources look unsalvageable when a rewrite reaches them.
    pub(crate) fn from_status(status: u16) -> Self {
        match status {
            200..=299 => Self::Reachable,
            401 | 403 | 451 => Self::Refused,
            404 | 410 => Self::Missing,
            _ => Self::Unreachable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{mirror_candidate, ProbeVerdict};

    #[test]
    fn rewrites_a_gitlab_raw_address_to_its_github_mirror() {
        // The two real addresses from the author's configuration, both of which answer 403 on
        // GitLab and 200 on GitHub.
        let candidate = mirror_candidate(
            "https://jihulab.com/yydfys/yydf/-/raw/main/yydf/lib/drpy2.min.js",
        )
        .expect("a known mirror must produce a candidate");
        assert_eq!(
            candidate.url,
            "https://raw.githubusercontent.com/yydfys/yydf/main/yydf/lib/drpy2.min.js"
        );

        let second =
            mirror_candidate("https://jihulab.com/yw88075/tvbox/-/raw/main/dr/lib/drpy2.min.js")
                .expect("a known mirror must produce a candidate");
        assert_eq!(
            second.url,
            "https://raw.githubusercontent.com/yw88075/tvbox/main/dr/lib/drpy2.min.js"
        );
    }

    #[test]
    fn leaves_every_other_address_alone() {
        // Nothing that is not a verified mirror may be rewritten: the address comes from a
        // third-party file, and a guessed rewrite would fetch an unrelated file and run it.
        for api in [
            // A different host entirely.
            "https://example.com/lib/drpy2.min.js",
            // GitLab, but not the raw form we verified.
            "https://jihulab.com/yydfys/yydf/-/blob/main/yydf/lib/drpy2.min.js",
            "https://jihulab.com/yydfys/yydf",
            // The mirror we would produce is never itself rewritten.
            "https://raw.githubusercontent.com/yydfys/yydf/main/yydf/lib/drpy2.min.js",
            // Plain HTTP is refused even on the mirrored host, so a rewrite cannot downgrade.
            "http://jihulab.com/yydfys/yydf/-/raw/main/yydf/lib/drpy2.min.js",
            // Local addresses are never candidates, whatever they contain.
            "https://127.0.0.1/-/raw/main/x.js",
            "https://localhost/-/raw/main/x.js",
            "",
            "not a url",
            // **A different GitLab instance with the identical path shape.** The mirror table names
            // one host because that is the one whose other copy was verified; treating every GitLab
            // as a mirror of GitHub would rewrite addresses nobody checked. Without this case the
            // host lookup is not exercised at all — the `/-/raw/` marker alone happens to reject
            // every other entry in this list.
            "https://gitlab.com/yydfys/yydf/-/raw/main/yydf/lib/drpy2.min.js",
            "https://gitlab.example.com/owner/repo/-/raw/main/x.js",
        ] {
            assert!(
                mirror_candidate(api).is_none(),
                "{api} must not be rewritten"
            );
        }
    }

    #[test]
    fn refuses_a_malformed_raw_path_rather_than_guessing() {
        // Each of these is a jihulab raw URL missing a piece the rewrite needs. Producing a
        // plausible-looking address from any of them would fetch the wrong file.
        for api in [
            // No ref or file after the marker.
            "https://jihulab.com/yydfys/yydf/-/raw/",
            // No file.
            "https://jihulab.com/yydfys/yydf/-/raw/main",
            "https://jihulab.com/yydfys/yydf/-/raw/main/",
            // No repo.
            "https://jihulab.com/yydfys/-/raw/main/x.js",
            // Too many owner segments.
            "https://jihulab.com/a/b/c/-/raw/main/x.js",
            // **The marker must be `/-/raw/` specifically.** GitLab uses `/-/` for several other
            // views, and only the raw one names the same file GitHub serves. Without these the
            // marker's exact text is untested: every case above is rejected by the segment checks
            // alone, so a rewrite that accepted any `/-/` path would still pass.
            "https://jihulab.com/yydfys/yydf/-/blob/main/yydf/lib/drpy2.min.js",
            "https://jihulab.com/yydfys/yydf/-/tree/main/yydf/lib/drpy2.min.js",
            "https://jihulab.com/yydfys/yydf/-/rawx/main/yydf/lib/drpy2.min.js",
        ] {
            assert!(
                mirror_candidate(api).is_none(),
                "{api} is malformed and must not be rewritten"
            );
        }
    }

    #[test]
    fn tells_a_refusal_apart_from_a_missing_file() {
        // The distinction the whole module exists for: 403 is what a mirror fixes, 404 is not.
        assert_eq!(ProbeVerdict::from_status(200), ProbeVerdict::Reachable);
        assert_eq!(ProbeVerdict::from_status(204), ProbeVerdict::Reachable);
        assert_eq!(ProbeVerdict::from_status(403), ProbeVerdict::Refused);
        assert_eq!(ProbeVerdict::from_status(401), ProbeVerdict::Refused);
        assert_eq!(ProbeVerdict::from_status(404), ProbeVerdict::Missing);
        assert_eq!(ProbeVerdict::from_status(410), ProbeVerdict::Missing);
        assert_eq!(ProbeVerdict::from_status(500), ProbeVerdict::Unreachable);
        assert_eq!(ProbeVerdict::from_status(302), ProbeVerdict::Unreachable);
    }

    #[test]
    fn a_refusal_is_not_reported_as_a_missing_file() {
        // Named separately from the status mapping so the wording cannot drift into "missing".
        assert_ne!(ProbeVerdict::from_status(403), ProbeVerdict::Missing);
        assert_eq!(ProbeVerdict::Refused.as_str(), "refused");
        assert_eq!(ProbeVerdict::Missing.as_str(), "missing");
    }

    /// Checks the two real addresses against the live network, using the app's own client.
    ///
    /// `#[ignore]`d because it needs the internet, so it is not part of the ordinary gate. Run it
    /// with `cargo test script_source -- --ignored --nocapture` when changing the mirror table.
    ///
    /// **Measured, and the measurement changed the design twice.** `jihulab.com` answers 403 to a
    /// *browser* User-Agent but 200 to the `Moseek/0.1` this app sends — so a Node-based probe using
    /// a browser UA reported both GitLab addresses as blocked when the app reaches the first one
    /// fine. And the second answers 404 to the app while the same repository path on GitHub serves
    /// 38 KiB, so a mirror helps even when the failure looks like "the file is gone" rather than
    /// "the host refuses". That is why the command tries the mirror on any failure.
    ///
    /// What must hold: the configured address does not yield a script, and its mirror does.
    #[test]
    #[ignore = "requires network access"]
    fn a_configured_address_that_serves_no_script_has_a_mirror_that_does() {
        fn looks_like_a_script(body: &str) -> bool {
            let head = body.trim_start().to_ascii_lowercase();
            !head.is_empty() && !head.starts_with("<!doctype html") && !head.starts_with("<html")
        }

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // The second address only: the first is reachable by the app as it stands, which is
            // itself the finding this test exists to record.
            let api = "https://jihulab.com/yw88075/tvbox/-/raw/main/dr/lib/drpy2.min.js";
            let candidate = mirror_candidate(api).expect("a known mirror");
            let direct = crate::policy::fetch_text_following_redirects(
                reqwest::Url::parse(api).unwrap(),
                1024 * 1024,
                "脚本内容",
                3,
            )
            .await;
            let mirrored = crate::policy::fetch_text_following_redirects(
                reqwest::Url::parse(&candidate.url).unwrap(),
                1024 * 1024,
                "脚本内容",
                3,
            )
            .await;

            let direct_is_script = direct.as_deref().map(looks_like_a_script).unwrap_or(false);
            let mirror_is_script = mirrored.as_deref().map(looks_like_a_script).unwrap_or(false);
            println!(
                "{api}\n  direct: {}\n  mirror ({}): {}",
                match &direct {
                    Ok(body) => format!("{} bytes, script={direct_is_script}", body.len()),
                    Err(error) => format!("error: {error}"),
                },
                candidate.url,
                match &mirrored {
                    Ok(body) => format!("{} bytes, script={mirror_is_script}", body.len()),
                    Err(error) => format!("error: {error}"),
                },
            );

            assert!(
                !direct_is_script,
                "the configured address must not serve a usable script, or the mirror is pointless"
            );
            assert!(
                mirror_is_script,
                "the mirror must serve the script the configured address does not"
            );
        });
    }
}
