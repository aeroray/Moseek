# Do Not Use

Rejected options, known failed paths, and tombstones. Check this before reintroducing an approach.

## MC-DNU-20261008-b2000006 — script runtime for imported sources

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000002
Facet: adoption-policy
Evidence:
- user-confirmed

Rejected:
No QuickJS sidecar, script archive, or runtime executing JavaScript, a JAR, or a spider from config.

## MC-DNU-20261008-b2000004 — the element `autoplay` attribute

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000004
Facet: behavior
Evidence:
- test:src/features/player/media-player-favorites-pane.test.tsx

Rejected:
Never set `autoplay` on the element or pass it to Plyr: Plyr then registers an unguarded `canplay`
handler that played a hidden live stream.

## MC-DNU-20261008-b2000005 — hiding a loading image

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000001
Facet: behavior
Evidence:
- test:src/components/poster-lightbox.test.tsx

Rejected:
Never hide a loading image with `visibility: hidden` or `display: none`; it breaks the accessibility
tree and the poster viewer. Hold its place with a transparent pixel.

## MC-DNU-20261008-b2000003 — stubbing `window.fetch` for media

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000005
Facet: workflow
Evidence:
- repo:src-tauri/src/resolver.rs

Rejected:
Never stub `window.fetch` for media: every byte goes through the Rust `fetch_media_resource` bridge,
so the stub matches nothing.

## MC-DNU-20261008-b2000002 — a control with one destination

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000002
Facet: behavior
Evidence:
- user-confirmed

Rejected:
No status column, filter facet, or badge whose every option resolves to the same value.
