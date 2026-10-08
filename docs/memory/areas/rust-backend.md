# Rust Backend

## MC-DEC-20261008-f1000001 — One policy gate for every outbound request

Status: active
Scope: area:rust-backend
Subject: MC-SUBJ-20261008-a1000007
Facet: security
Evidence:
- repo:src-tauri/src/policy.rs

Decision:
Public HTTP/HTTPS only, bounded bodies, redirects disabled except where predicting playback requires
them, DNS pinned per resolution. Loopback, private ranges, and unsupported protocols are refused.

## MC-DEC-20261008-f1000002 — A refused fetch is not a dead source

Status: active
Scope: area:rust-backend
Subject: MC-SUBJ-20261008-a1000007
Facet: behavior
Evidence:
- repo:src-tauri/src/live.rs

Decision:
Distinguish an upstream rejection (401/403), a peer that closes the connection, and a 200 that is not a
playlist. They are three problems and must not share one sentence.

## MC-DEC-20261008-f1000003 — Convert byte ranges rather than forward them

Status: active
Scope: area:rust-backend
Subject: MC-SUBJ-20261008-a1000007
Facet: compatibility
Evidence:
- repo:src/features/player/media-player.tsx

Decision:
hls.js supplies an exclusive `rangeEnd`; sending its default fragment offsets `0/0` as `bytes=0-0`
truncates ordinary fragments and yields a black player.

## MC-DEC-20261008-f1000004 — Playlists get a smaller budget than fragments

Status: active
Scope: area:rust-backend
Subject: MC-SUBJ-20261008-a1000007
Facet: performance
Evidence:
- repo:src-tauri/src/resolver.rs

Decision:
Cap playlists at 1 MiB and fragments at 16 MiB, so a non-HLS address fails as "not a playlist" instead
of on a size limit after streaming megabytes.

## MC-DEC-20261008-f1000005 — Incremental compilation stays disabled

Status: active
Scope: area:rust-backend
Subject: MC-SUBJ-20261008-a1000007
Facet: workflow
Evidence:
- repo:src-tauri/Cargo.toml

Decision:
Keep incremental compilation off for the dev and test profiles: Windows antivirus intermittently denies
writes under `target/debug/incremental`, and rustc panics with an ICE rather than degrading.
