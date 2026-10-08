# Project Brief

**Moseek (拾影)** is a Windows desktop player for TVBox/CatVod-style IPTV and VOD configurations.
It imports a config file, normalizes its sources, and plays CMS catalogues and live channels through
adapters that execute nothing remote.

## Shape

- **Tauri 2 + Rust + React 19 + Vite + TS + Tailwind v4 + shadcn/ui.** Rust owns all network access,
  parsing, storage, and playback resolution; the WebView never contacts a CDN or media host directly.
- **Sources are classified, not trusted.** The parser decides what each entry is; a registry maps that
  to an adapter. Only declarative families run. Remote JS, JAR, and spiders are refused and pruned.
- **Config is a living document.** Multiple named documents, one active; sources carry enablement,
  probe status, and capability per document.
- **Playback** is Plyr + hls.js + mpegts.js behind a Rust media loader, so manifests and segments pass
  the same URL/header/redirect/DNS policy as everything else.

## Current direction

Reliability over breadth. The product is judged on whether CMS and live actually play, so recent work
removed adapters and UI that promised capabilities the app does not have, and fixed defects where the
UI reported success while playback, posters, or guides silently failed.

## Working rules

- **Verify in a real browser, not only in jsdom.** Layout, media, and worker behaviour need the real
  engine; several past defects passed every unit test.
- **Mutation-test new assertions** — confirm the test fails when the behaviour is broken.
- **Prefer deleting an unreachable path over describing it.**
- **Never write source files with PowerShell redirection** — it corrupts CJK. See `constraints.md`.
