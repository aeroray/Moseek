# Archived Memory: changelog.md

Complete historical entries moved from active memory after reviewed compaction.
This file is explicit-only and is not part of normal task context.

## 2026-10-20 — Build targets: Windows + Apple silicon only

Windows (NSIS) and macOS **Apple silicon only**. `x86_64-apple-darwin` is deliberately
absent from `release.yml`, so `latest.json` carries only `darwin-aarch64` and an Intel
Mac sees "no update" rather than a wrong-architecture package. `minimumSystemVersion`
is 11.0 to match. Restoring Intel is one matrix row.

**Release notes are written at release time.** No tags exist yet, so `docs/releases/`
holds only a convention note. Do not pre-write `<tag>.md` speculatively — the workflow
reads it when the tag is pushed and fails loudly if missing, which is the guard.
