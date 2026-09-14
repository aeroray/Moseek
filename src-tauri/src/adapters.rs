use crate::SourceRecord;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SiteAdapterKind {
    XmlHttp,
    JsonHttp,
    HttpExtension,
    Spider,
    Unsupported,
}

impl SiteAdapterKind {
    pub(crate) fn from_source(source: &SourceRecord) -> Self {
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
            Some("spider") | Some("3") => Self::Spider,
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
}

fn site_type_name(site_type: i64) -> &'static str {
    match site_type {
        0 => "0",
        1 => "1",
        3 => "3",
        4 => "4",
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
            site_type,
            site_protocol: site_protocol.map(ToOwned::to_owned),
            api: "https://example.com/api".to_string(),
            ext: None,
            jar: None,
            epg: None,
            searchable: true,
            filterable: true,
            capability: "supported".to_string(),
            capability_note: "ok".to_string(),
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
    }

    #[test]
    fn blocks_spider_before_network_execution() {
        let spider = source(Some(3), None);

        assert!(SiteAdapterKind::from_source(&spider)
            .ensure_executable(&spider)
            .is_err());
    }
}
