# Moseek · 拾影

English · [简体中文](README.md)

A Windows desktop player: import a TVBox / CatVod-style configuration, and browse a film library and
live TV. **Nothing in a configuration is ever executed — remote scripts, JARs and spiders are refused.**

![Library](docs/images/library.png)

## Features

- **Movies and live TV** — category browsing, search, episode selection; grouped channels, TV guides
  and per-line testing. HLS and FLV both play.
- **Sources are identified before they are used** — each one is classified on import: working sources
  work, broken ones say why. Nothing is dropped silently.
- **See it before you import it** — a configuration is listed in full first (films / live / resolvers);
  you tick what you want.
- **One configuration** — repeated imports merge and deduplicate. Favourites, footprints and playback
  progress are stored separately from configurations.
- **One network gate** — everything passes a Rust network layer that refuses loopback, private-range
  and dangerous-scheme addresses.

## Download

Grab the Windows installer (NSIS) from [Releases](https://github.com/aeroray/Moseek/releases).
The app checks for updates on GitHub Releases and offers them in-app.

## Building from source

You need [Node.js](https://nodejs.org) 22+, [pnpm](https://pnpm.io) 11+ and [Rust](https://rustup.rs).

```bash
pnpm install
pnpm tauri dev     # run in development
pnpm tauri build   # produce the installer (src-tauri/target/release/bundle/)
```

Other commands: `pnpm test` (unit tests), `pnpm lint`, `pnpm typecheck`, `pnpm build` (frontend only).

## What it does not do

- Windows only; no mobile platforms.
- It ships no sources of its own. You need your own configuration file, obtained legitimately.

## Tech stack

Tauri 2 · Rust · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui · Plyr / hls.js / mpegts.js

## License

[MIT](LICENSE)
