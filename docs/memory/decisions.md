# Decisions

- Package manager: pnpm.
- Frontend foundation: React + Vite + TypeScript.
- Desktop foundation: Tauri 2 with Rust commands reserved for network access, parsing, storage, and playback resolution.
- UI direction: a dense content operations console with coral brand accents, blue primary actions, semantic capability status colors, IBM Plex Sans for interface text, and Space Grotesk for display values.
- MVP support boundary: ordinary CMS APIs, basic live sources, HTTP parsing endpoints, and explicit diagnostics; remote JAR, spider, Drpy JS, unsupported CSP adapters, and private protocols remain non-executable.
- Vite watcher ignores `src-tauri/**` because Windows file locks in Rust build artifacts can otherwise terminate the frontend dev server with `EBUSY`.
- Tauri uses the checked-in `src-tauri/icons/icon.svg` as the source for generated platform icons; the current bundle is disabled until installer packaging is configured.
- Phase 3 ordinary CMS support uses Rust reqwest commands for common `ac=list` and `ac=detail` JSON APIs, normalizing list/detail/play-line fields into the shared `VodItem` model; browser preview falls back to local demo catalog data without bypassing the Rust network boundary.
