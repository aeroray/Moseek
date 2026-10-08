# Decisions

## MC-DEC-20261008-68bfcfb4 — Desktop stack

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000001
Facet: architecture
Evidence:
- repo:package.json
- repo:src-tauri/Cargo.toml

Decision:
Tauri 2 + Rust with React 19, Vite, TypeScript, Tailwind v4, and shadcn/ui.

Reason:
A desktop webview gives the media stack real codecs while Rust keeps network, parsing, and storage out of the UI process.

## MC-DEC-20261008-3b9c0ef4 — Capability is derived from the parser

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000003
Facet: behavior
Evidence:
- repo:src/features/config/config-parser.ts

Decision:
Decide what a source can do from the parser's classification of its fields, never from the stored
`capability` value, and remove entries that can never run from the saved configuration.

Reason:
A stored capability is written once and never revisited, so it drifts from what the app can execute.

## MC-DEC-20261008-155a7632 — One active configuration document

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000003
Facet: data-model
Evidence:
- repo:src/stores/app-store.ts

Decision:
Keep multiple named configuration documents with exactly one active, and scope source enablement, probe status, and snapshots to their document.

Reason:
Identical source keys recur across imported configurations, so document scoping keeps them from colliding.

## MC-DEC-20261008-01a69b71 — Delete a capability rather than describe it

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000002
Facet: interface
Evidence:
- user-confirmed

Decision:
Do not list an adapter, status column, or filter facet the app cannot act on, and drop any control whose every option leads to the same place.

Reason:
A row naming another client's plugin family answers a question the user did not ask, and a filter with one destination is not a filter.

## MC-DEC-20261008-9992d36c — Verify UI and media in a real browser

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000001
Facet: workflow
Evidence:
- user-confirmed

Decision:
Check layout, media, and worker behaviour against the built bundle in a real browser, and mutation-test every new assertion.

Reason:
jsdom has no layout engine and no MediaSource, so several defects passed the full unit suite; an assertion that survives broken behaviour proves nothing.
