use crate::SourceRecord;

/// The implementation family named in a source's `key` or `api`.
///
/// TVBox gives every script family the same `type: 3` shape and lets the packager name the source
/// freely, so the marker lives in whichever field they chose: `api: "csp_XBPQ"` with an arbitrary
/// `key` such as `fok`, or `key: "csp_XBPQ"` with a plain `api`.
enum ScriptFamily {
    /// Read by fetching pages and following the configuration's own URL templates. Nothing is
    /// executed, so these are supported.
    Declarative,
    /// Remote code that would have to run to do anything. Blocked.
    RemoteCode,
}

/// Names the family for a source, or `None` when nothing identifies one.
///
/// This mirrors `remoteScriptFamily` in `src/lib/adapters.ts`, **including its order**: drpy is
/// tested before the declarative families and AppMao after, so a name containing more than one
/// marker resolves the same way on both sides. The two readings have to agree — the interface
/// decides whether to offer a test button from them, and a source that looks testable on screen has
/// to be testable in fact.
fn script_family(source: &SourceRecord) -> Option<ScriptFamily> {
    let haystack = format!(
        "{} {}",
        source.key.to_lowercase(),
        source.api.to_lowercase()
    );
    if haystack.contains("drpy") {
        return Some(ScriptFamily::RemoteCode);
    }
    if haystack.contains("xbpq") || haystack.contains("panda") || haystack.contains("xyqhiker") {
        return Some(ScriptFamily::Declarative);
    }
    if haystack.contains("appmao") {
        return Some(ScriptFamily::RemoteCode);
    }
    None
}

/// Whether an address uses a scheme that must never be fetched or executed.
fn has_dangerous_scheme(api: &str) -> bool {
    let lower = api.trim().to_ascii_lowercase();
    ["javascript:", "data:", "file:", "shell:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

/// Whether a live source's address is one the Rust loader can actually fetch.
///
/// Mirrors the parser's live rules and `isTestableLiveSource` in `src/lib/adapters.ts`.
pub(crate) fn is_fetchable_live_url(api: &str) -> bool {
    let trimmed = api.trim();
    !trimmed.is_empty()
        && !has_dangerous_scheme(trimmed)
        && (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SiteAdapterKind {
    XmlHttp,
    JsonHttp,
    HttpExtension,
    Html,
    /// Declarative XBPQ / XYQHiker sources.
    ///
    /// These are `type: 3` and almost always ship a JAR, so they look like spiders. The
    /// configuration they actually consume is a vocabulary of URL templates and text markers
    /// with nothing executable in it, which the adapter reads directly — so they belong on the
    /// same "fetch a page, read it declaratively" path as `Html`, not the spider one.
    Xbpq,
    Spider,
    Unsupported,
}

impl SiteAdapterKind {
    pub(crate) fn from_source(source: &SourceRecord) -> Self {
        // An explicit declarative protocol wins over the presence of a JAR. These sources carry a
        // JAR for their TVBox runtime, but the configuration Moseek reads does not need it, and
        // letting the JAR check run first would send every one of them back to `Spider`.
        if matches!(source.site_protocol.as_deref(), Some("xbpq")) {
            return Self::Xbpq;
        }
        // The implementation family is named in `key` or `api`, not only in `site_protocol`.
        //
        // The parser derives `site_protocol` at import time and stores it, so a document written
        // before a family was supported carries a stale value — the author's database holds 105 such
        // sources, whose `site_protocol` is null while `api` plainly reads `csp_XBPQ`. Those fell
        // through to the JAR check below and were refused as spiders, so a source the interface
        // offered a 测试 button for answered "Spider、远程脚本或 JAR 适配器当前不会执行".
        //
        // This mirrors `remoteScriptFamily` in `src/lib/adapters.ts` exactly. The two must agree:
        // the interface decides whether to offer a test from the same reading of the same fields,
        // and a source that is testable on screen has to be testable in fact.
        match script_family(source) {
            // Only the declarative families are readable without executing anything.
            Some(ScriptFamily::Declarative) => return Self::Xbpq,
            // drpy and AppMao are remote code; they stay on the blocked path.
            Some(ScriptFamily::RemoteCode) => return Self::Spider,
            None => {}
        }
        if source.jar.is_some() {
            return Self::Spider;
        }
        match source
            .site_protocol
            .as_deref()
            .or_else(|| source.site_type.map(site_type_name))
        {
            Some("xml-http") | Some("0") => Self::XmlHttp,
            Some("json-http") | Some("1") => Self::JsonHttp,
            Some("http-extension") | Some("4") => Self::HttpExtension,
            Some("html-http") | Some("5") => Self::Html,
            // A `js-extension` source is a CatVod script source, and it is enforced as a spider:
            // `ensure_executable` refuses the family below because it needs a script runtime this
            // app does not have. The comment here used to say the source became executable once the
            // user bound a local script archive; that runtime has been removed, so there is no
            // longer any path that makes one of these run. Naming the protocol here keeps this match
            // aligned with the vocabulary the parser actually produces — it previously fell through
            // to the `source_type == "cms"` catch-all and was treated as plain JSON.
            Some("js-extension") | Some("spider") | Some("3") => Self::Spider,
            Some("unknown") => Self::Unsupported,
            _ if source.source_type == "cms" => Self::JsonHttp,
            _ => Self::Unsupported,
        }
    }

    /// Whether this source may be executed, or why not.
    ///
    /// **The refusal is derived from the source as it stands, not from its stored `capability`.**
    /// That field is written by the parser at import time and never revisited, so it goes stale the
    /// moment support is added. Gating on it made the interface and the backend disagree about the
    /// same source: the interface offered a 测试 button — it reads the live adapter registry — and
    /// this function answered "Spider、远程脚本或 JAR 适配器当前不会执行" from a stored value written
    /// before XBPQ support existed. The author's database held 84 such sources, and re-deriving the
    /// answer here resolves every one of them without permitting anything the parser refuses.
    ///
    /// The checks below are the parser's own conditions, evaluated against the current record:
    /// a missing or dangerous address, a malformed record, or a family that needs remote code.
    pub(crate) fn ensure_executable(self, source: &SourceRecord) -> Result<Self, String> {
        if source.api.trim().is_empty() {
            return Err("缺少可用的接口地址，无法建立请求。".to_string());
        }
        if has_dangerous_scheme(&source.api) {
            return Err("检测到危险协议，Moseek 默认阻止执行。".to_string());
        }
        match self {
            // A spider is refused because the family needs a runtime, not because a stored field
            // said so. The message names the actual reason.
            Self::Spider => match script_family(source) {
                Some(ScriptFamily::RemoteCode) => {
                    Err("该源依赖远程脚本或 JAR，Moseek 只记录和展示，不会执行。".to_string())
                }
                _ => Err("该源需要 Spider 运行时，Moseek 只记录和展示，不会执行。".to_string()),
            },
            Self::Unsupported => Err("无法确认该源的安全适配边界。".to_string()),
            _ => Ok(self),
        }
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::XmlHttp => "xml-http",
            Self::JsonHttp => "json-http",
            Self::HttpExtension => "http-extension",
            Self::Html => "html-http",
            Self::Xbpq => "xbpq",
            Self::Spider => "spider-runtime",
            Self::Unsupported => "unknown",
        }
    }
}

fn site_type_name(site_type: i64) -> &'static str {
    match site_type {
        0 => "0",
        1 => "1",
        3 => "3",
        4 => "4",
        5 => "5",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::{is_fetchable_live_url, SiteAdapterKind};
    use crate::SourceRecord;

    fn source(site_type: Option<i64>, site_protocol: Option<&str>) -> SourceRecord {
        SourceRecord {
            key: "demo".to_string(),
            name: "Demo".to_string(),
            source_type: "cms".to_string(),
            source_dialect: None,
            site_type,
            site_protocol: site_protocol.map(ToOwned::to_owned),
            api: "https://example.com/api".to_string(),
            logo: None,
            description: None,
            nsfw: false,
            status: true,
            ext: None,
            extra: None,
            jar: None,
            epg: None,
            searchable: true,
            filterable: true,
            capability: "supported".to_string(),
            capability_note: "ok".to_string(),
            test_status: None,
            test_message: None,
            tested_at: None,
            test_item_count: None,
            test_category_count: None,
            test_duration_ms: None,
            test_operations: Vec::new(),
            enabled: true,
            last_checked_at: "刚刚".to_string(),
            request_count: 0,
        }
    }

    #[test]
    fn routes_explicit_site_types() {
        assert_eq!(
            SiteAdapterKind::from_source(&source(Some(0), None)),
            SiteAdapterKind::XmlHttp
        );
        assert_eq!(
            SiteAdapterKind::from_source(&source(Some(1), None)),
            SiteAdapterKind::JsonHttp
        );
        assert_eq!(
            SiteAdapterKind::from_source(&source(Some(3), None)),
            SiteAdapterKind::Spider
        );
        assert_eq!(
            SiteAdapterKind::from_source(&source(Some(4), None)),
            SiteAdapterKind::HttpExtension
        );
        assert_eq!(
            SiteAdapterKind::from_source(&source(Some(5), None)),
            SiteAdapterKind::Html
        );
    }

    #[test]
    fn blocks_spider_before_network_execution() {
        let spider = source(Some(3), None);

        assert!(SiteAdapterKind::from_source(&spider)
            .ensure_executable(&spider)
            .is_err());
    }

    #[test]
    fn routes_a_declarative_family_named_only_in_the_api() {
        // The author's real shape: a document written before XBPQ support was stored with
        // `site_protocol: null`, while `api` plainly names the family. The interface reads the api
        // and offers a test; the backend used to read only `site_protocol`, fall through to the JAR
        // check, and answer "Spider、远程脚本或 JAR 适配器当前不会执行" for a source it could run.
        let mut stored = source(None, None);
        stored.api = "csp_XBPQ".to_string();
        stored.jar = Some("https://example.com/1.jar".to_string());

        assert_eq!(SiteAdapterKind::from_source(&stored), SiteAdapterKind::Xbpq);
        assert!(SiteAdapterKind::Xbpq.ensure_executable(&stored).is_ok());
    }

    #[test]
    fn routes_every_declarative_family_named_in_the_key() {
        for family in ["csp_XBPQ", "csp_Panda", "csp_XYQHiker"] {
            let mut stored = source(Some(3), None);
            stored.key = family.to_string();
            stored.jar = Some("https://example.com/1.jar".to_string());

            assert_eq!(
                SiteAdapterKind::from_source(&stored),
                SiteAdapterKind::Xbpq,
                "{family} should be readable declaratively"
            );
        }
    }

    #[test]
    fn still_refuses_the_remote_code_families() {
        // drpy and AppMao need their script to run, so naming a family must not become a way in.
        for family in ["drpy_js_demo", "csp_AppMao"] {
            let mut stored = source(Some(3), None);
            stored.key = family.to_string();

            assert_eq!(
                SiteAdapterKind::from_source(&stored),
                SiteAdapterKind::Spider,
                "{family} is remote code"
            );
            assert!(SiteAdapterKind::from_source(&stored)
                .ensure_executable(&stored)
                .is_err());
        }
    }

    #[test]
    fn drpy_wins_over_a_declarative_name_in_the_same_source() {
        // The front end tests drpy first, so a name containing both markers resolves to the blocked
        // family on both sides. Order is part of the contract, not an implementation detail.
        let mut stored = source(None, None);
        stored.key = "drpy_xbpq".to_string();

        assert_eq!(
            SiteAdapterKind::from_source(&stored),
            SiteAdapterKind::Spider
        );
    }

    #[test]
    fn ignores_a_stale_blocked_capability() {
        // The refusal is derived from the source as it stands. Gating on the stored capability made
        // the interface and the backend disagree: the interface offered a test button, and this
        // answered from a value written before the support existed.
        let mut stale = source(Some(3), Some("xbpq"));
        stale.capability = "blocked".to_string();
        stale.capability_note =
            "API 部分可用；存在远程 JAR 依赖，Moseek 不会下载或执行。".to_string();
        stale.jar = Some("https://example.com/1.jar".to_string());

        assert_eq!(SiteAdapterKind::from_source(&stale), SiteAdapterKind::Xbpq);
        assert!(SiteAdapterKind::Xbpq.ensure_executable(&stale).is_ok());
    }

    #[test]
    fn still_refuses_a_source_with_no_usable_address() {
        // The checks that replace the capability gate are the parser's own conditions, evaluated
        // against the current record. A record with nothing to request is refused either way.
        for api in ["", "   "] {
            let mut broken = source(Some(1), Some("json-http"));
            broken.api = api.to_string();
            broken.capability = "supported".to_string();

            assert!(SiteAdapterKind::JsonHttp
                .ensure_executable(&broken)
                .is_err());
        }
    }

    #[test]
    fn still_refuses_a_dangerous_scheme() {
        // The parser marks these blocked, and the gate has to keep refusing them now that it no
        // longer reads that field.
        for api in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "shell:cmd",
        ] {
            let mut dangerous = source(Some(1), Some("json-http"));
            dangerous.api = api.to_string();
            dangerous.capability = "supported".to_string();

            assert!(
                SiteAdapterKind::JsonHttp
                    .ensure_executable(&dangerous)
                    .is_err(),
                "{api} must stay refused"
            );
        }
    }

    #[test]
    fn live_urls_are_fetchable_only_when_they_are_http() {
        for api in ["https://live.example/tv.txt", "http://live.example/tv.txt"] {
            assert!(is_fetchable_live_url(api), "{api} should be fetchable");
        }
        for api in [
            "",
            "  ",
            "proxy://demo",
            "./libs/tv/tvlive.txt",
            "file:///x",
            "javascript:1",
        ] {
            assert!(!is_fetchable_live_url(api), "{api} must not be fetched");
        }
    }

    #[test]
    fn routes_a_declarative_xbpq_source_ahead_of_its_jar() {
        // Real shape: `api: "csp_XBPQ"`, `type: 3`, and a JAR for the TVBox runtime. The JAR is
        // not needed for the configuration Moseek reads, so it must not send the source back to
        // the blocked spider path.
        let mut xbpq = source(Some(3), Some("xbpq"));
        xbpq.jar = Some("https://example.com/adapter.jar".to_string());

        assert_eq!(SiteAdapterKind::from_source(&xbpq), SiteAdapterKind::Xbpq);
        assert_eq!(SiteAdapterKind::Xbpq.id(), "xbpq");
        assert!(SiteAdapterKind::Xbpq.ensure_executable(&xbpq).is_ok());
    }

    #[test]
    fn recognises_the_js_extension_protocol_the_config_parser_produces() {
        // The parser emits `js-extension`, which this match did not name, so such a source fell
        // through to the `source_type == "cms"` catch-all and was handled as plain JSON.
        let js_extension = source(Some(1), Some("js-extension"));

        assert_eq!(
            SiteAdapterKind::from_source(&js_extension),
            SiteAdapterKind::Spider
        );
    }

    #[test]
    fn still_blocks_a_plain_spider_with_a_jar() {
        // The XBPQ exemption must be protocol-specific, not "any source with a JAR".
        let mut jar_spider = source(Some(3), Some("spider"));
        jar_spider.jar = Some("https://example.com/adapter.jar".to_string());

        assert_eq!(
            SiteAdapterKind::from_source(&jar_spider),
            SiteAdapterKind::Spider
        );
    }
}
