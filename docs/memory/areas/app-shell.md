# App Shell

The window chrome, the navigation rail, and how a view is kept alive behind it.

## MC-DEC-20261008-b1000001 — The app draws its own window chrome

Status: active
Scope: area:app-shell
Subject: MC-SUBJ-20261008-a1000008
Facet: lifecycle
Evidence:
- repo:src-tauri/tauri.conf.json

Decision:
Run frameless with a self-drawn, text-free bar: the mark, then minimize, maximize and close. The title
stays the Chinese product name, which is what Windows shows on the taskbar. Draw no window buttons
outside the desktop runtime.

## MC-DEC-20261008-b1000002 — A view stays mounted while the user is elsewhere

Status: active
Scope: area:app-shell
Subject: MC-SUBJ-20261008-a1000008
Facet: architecture
Evidence:
- repo:src/components/view-pane.tsx

Decision:
Hide with `visibility: hidden` plus `opacity-0`, never `display: none` (the virtualiser reads a
zero-height container as "no layout engine") and never by unmounting (that destroys search and scroll).
`opacity-0` is load-bearing: `visibility` interpolates.

## MC-DEC-20261008-b1000003 — Validate persisted state by type, not nullability

Status: active
Scope: area:app-shell
Subject: MC-SUBJ-20261008-a1000008
Facet: data-model
Evidence:
- repo:src/stores/app-store.ts

Decision:
`?.trim()` still throws on a number, and an unknown `activeView` renders a blank workspace. Test that a
migration is called, not only that it is correct: a spread can overwrite a validated value.
