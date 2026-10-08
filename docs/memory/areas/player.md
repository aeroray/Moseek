# Live Playback

## MC-DEC-20261008-d1000001 — A hidden view must not play or fetch

Status: active
Scope: area:player
Subject: MC-SUBJ-20261008-a1000004
Facet: lifecycle
Evidence:
- repo:src/components/view-pane.tsx

Decision:
Views stay mounted while the user is elsewhere, so the player pauses on leave and resumes on return.
Every path that can start playback checks `viewAwayRef`: the retry timer, the FLV reconnect, the HLS
window refresh, and pipeline construction itself.

## MC-DEC-20261008-d1000002 — Never write the element `autoplay` attribute

Status: active
Scope: area:player
Subject: MC-SUBJ-20261008-a1000004
Facet: security
Evidence:
- test:src/features/player/media-player-favorites-pane.test.tsx

Decision:
Plyr forces its own config true from that attribute, whatever the constructor was told, then registers
an unguarded `canplay` handler. Start playback only through the guarded path.

## MC-DEC-20261008-d1000003 — A deferred pipeline must be rebuilt on return

Status: active
Scope: area:player
Subject: MC-SUBJ-20261008-a1000004
Facet: architecture
Evidence:
- repo:src/features/player/media-player.tsx

Decision:
A pipeline refused while the view was away records that it is owed, so the return path reloads or
rebuilds it; otherwise stopping the audio leaves a permanently black pane.

## MC-DEC-20261008-d1000004 — Live cannot resume with a bare `play()`

Status: active
Scope: area:player
Subject: MC-SUBJ-20261008-a1000004
Facet: compatibility
Evidence:
- repo:src/features/player/media-player.tsx

Decision:
A paused live element holds stale buffer, so returning re-seeks to the live edge (hls.js
`startLoad(-1)`) or flushes the transmuxer (mpegts `load()`).

## MC-DEC-20261008-d1000005 — Strip only the guide watermark's exact tail

Status: active
Scope: area:player
Subject: MC-SUBJ-20261008-a1000004
Facet: data-model
Evidence:
- repo:src-tauri/src/live.rs

Decision:
Providers append an advertisement to every programme title, so remove that one exact trailing phrase.
Never apply a fuzzy decoration rule: real titles contain digits such as `生逢其时11/26`.
