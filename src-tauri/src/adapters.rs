use crate::SourceRecord;

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
            // A `js-extension` source is a CatVod script source. It is only executable once the
            // user binds a local script archive, which the config parser records as
            // `local-script`; without one there is no safe adapter and `ensure_executable`
            // rejects it on its capability. Naming it here keeps this match aligned with the
            // protocol vocabulary the parser actually produces — it previously fell through to
            // the `source_type == "cms"` catch-all and was treated as plain JSON.
            Some("js-extension") | Some("spider") | Some("3") => Self::Spider,
            Some("unknown") => Self::Unsupported,
            _ if source.source_type == "cms" => Self::JsonHttp,
            _ => Self::Unsupported,
        }
    }

    pub(crate) fn ensure_executable(self, source: &SourceRecord) -> Result<Self, String> {
        if source.capability == "blocked" || source.capability == "invalid" {
            return Err(source.capability_note.clone());
        }
        match self {
            Self::Spider => Err("Spider、远程脚本或 JAR 适配器当前不会执行。".to_string()),
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
    use super::SiteAdapterKind;
    use crate::SourceRecord;

    fn source(site_type: Option<i64>, site_protocol: Option<&str>) -> SourceRecord {
        SourceRecord {
            key: "demo".to_string(),
            name: "Demo".to_string(),
            source_type: "cms".to_string(),
            script_archive_id: None,
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
