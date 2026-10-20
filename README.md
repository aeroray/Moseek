# Moseek · 拾影

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows · macOS](https://img.shields.io/badge/Platform-Windows%20%C2%B7%20macOS-0078D4.svg)](#download)

[简体中文](README.zh-CN.md) · English

A desktop player for TVBox / CatVod-style configurations: import one config file, then watch movies
and live TV. **Nothing in a configuration is ever executed — remote scripts, JARs and spiders are
refused.**

![Moseek's movie grid](docs/images/library.png)

## Features

- **Movies and live TV** — category browsing, search and episode selection; grouped channels, TV
  guides and per-line testing. HLS and FLV both play.
- **Sources are identified before they are used** — every source is classified on import: working
  sources work, broken ones say why. Nothing is dropped silently.
- **See it before you import it** — a configuration is listed in full first (films / live / resolvers);
  you tick what you want.
- **One configuration** — repeated imports merge and deduplicate. Favourites, footprints and playback
  progress are stored separately from configurations.
- **One network gate** — all traffic passes a Rust layer that refuses loopback, private-range and
  dangerous-scheme addresses, and re-checks every redirect hop. Player fetch paths go through it too;
  the one exception is a native MP4, which the system player connects to itself — so it is validated
  by that same gate before the element is ever given the address.

## Download

Windows installer (NSIS), or a macOS `.dmg` (Apple silicon only), from
[Releases](https://github.com/aeroray/Moseek/releases). The app checks for updates on GitHub Releases
and offers them in-app.

> **macOS:** the build is ad-hoc signed, not notarised — a paid Apple developer account is not
> something a free project should need. On first launch, right-click the app and choose **Open**, or
> allow it under **System Settings → Privacy & Security**. After that it starts normally.

> **Upgrading to 1.0.0 from an earlier build:** the updater signing key was rotated in 1.0.0, so older
> installs will say the update cannot be verified. Download 1.0.0 by hand once; automatic updates
> resume from there.

## Build from source

Requires [Node.js](https://nodejs.org) 22+, [pnpm](https://pnpm.io) 11+ and
[Rust](https://rustup.rs).

```bash
pnpm install
pnpm tauri dev     # run in development
pnpm tauri build   # produce the installer in src-tauri/target/release/bundle/
```

Other scripts: `pnpm test` (unit tests), `pnpm lint`, `pnpm typecheck`, `pnpm build` (frontend only).

> **Native MP4 does not play in the browser preview.** `pnpm dev` has no Rust network layer, and the
> native `<video>` branch refuses an address it cannot verify rather than handing the element a URL
> the policy never saw. HLS and FLV are unaffected. That is deliberate: no gate, no playback. Judge
> media behaviour in the desktop app.

## Scope

- Desktop only — Windows and macOS (Apple silicon only). No mobile platforms.
- No sources are bundled. You need your own configuration file, obtained legitimately.

## Tech stack

Tauri 2 · Rust · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui · Plyr / hls.js / mpegts.js

## Contributing

Bug reports and ideas are welcome via [Issues](https://github.com/aeroray/Moseek/issues).

## License

[MIT](LICENSE)
