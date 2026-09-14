# Decisions

- Package manager: pnpm.
- Frontend foundation: React + Vite + TypeScript.
- Desktop foundation: Tauri 2 with Rust commands reserved for network access, parsing, storage, and playback resolution.
- UI direction: a dense content operations console with coral brand accents, blue primary actions, semantic capability status colors, IBM Plex Sans for interface text, and Space Grotesk for display values.
- MVP support boundary: ordinary CMS APIs, basic live sources, HTTP parsing endpoints, and explicit diagnostics; remote JAR, spider, Drpy JS, unsupported CSP adapters, and private protocols remain non-executable.
- Vite watcher ignores `src-tauri/**` because Windows file locks in Rust build artifacts can otherwise terminate the frontend dev server with `EBUSY`.
- Tauri uses the checked-in `src-tauri/icons/icon.svg` as the source for generated platform icons; the current bundle is disabled until installer packaging is configured.
- Phase 3 ordinary CMS support uses Rust reqwest commands for common `ac=list` and `ac=detail` JSON APIs, normalizing list/detail/play-line fields into the shared `VodItem` model; unavailable remote data stays an explicit empty/error state.
- Phase 4 media playback uses Plyr 3.8 with hls.js for HLS and native video for MP4. Progress, movie favorites, and live-channel favorites persist in the frontend store; live M3U/TXT/JSON parsing and XMLTV/JSON EPG parsing remain behind Rust commands with explicit empty/error states.
- External playback is user-triggered through `tauri-plugin-opener` and only accepts HTTP/HTTPS URLs. CMS episode URLs and live stream URLs are rejected when they use dangerous, localhost, private-network, or unsupported protocols.
- Phase 5 uses a transparent adapter registry: ordinary HTTP/type-3 CMS and live sources use built-in adapters; HTTP parser support is partial; Drpy JS, XBPQ, CSP extensions, remote JAR, spider, and private protocols are represented as blocked or needs-adapter entries and are never executed.
- JSON configuration surfaces use CodeMirror 6 with the project font token; import and raw configuration views share one editor component with bounded internal scrolling.
- The application is library-first: the obsolete overview and top header were removed, navigation remains in the sidebar, and theme selection lives in Settings.
- Configuration management uses multiple named documents with one active document at a time; normalized source snapshots and enablement state are scoped to the document so identical source keys cannot collide across imported configurations.
- Safe site dispatch uses Rust adapters for type 0 XML HTTP, type 1 JSON HTTP, and restricted type 4 HTTP-extension scalar parameters; type 3 Spider, remote JAR, and remote script paths remain blocked. All remote fetches and playback URLs pass through the shared HTTP/HTTPS policy gate with bounded responses and redirects disabled.
