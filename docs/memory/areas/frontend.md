# Frontend

Shared components and UI primitives under `src/`.

## MC-DEC-20261008-a1000002 — Images are fetched by Rust and injected as data URLs

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: interface
Evidence:
- repo:src/components/policy-image.tsx

Decision:
An `<img>` with no `src` paints a broken-image glyph: hold its place with a transparent pixel and swallow
its `load`.

## MC-DEC-20261008-a1000003 — Scroll roots need explicit type and min-height

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: behavior
Evidence:
- repo:src/components/ui

Decision:
A scroll root needs `min-h-0`; a `ScrollArea` needs `type="auto"` — Radix defaults to `hover`.

## MC-DEC-20261008-a1000004 — Size geometry must not use `data-[size]` padding variants

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: compatibility
Evidence:
- test:src/components/ui/ui-primitives.test.tsx

Decision:
`data-[size=*]:px-*` outranks a caller's `pl-8`. Emit size geometry as plain classes instead.

## MC-DEC-20261008-a1000005 — Overlays tint the icon, not the panel

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: architecture
Evidence:
- repo:src/components/ui/toast.tsx

Decision:
A toast body stays on `bg-card/95` with `shadow-xl backdrop-blur-md`; only the icon carries the status
colour. `--status-*-bg` is a 12% badge tint, not a panel fill.

## MC-DEC-20261008-a1000006 — One type scale: 14/500 names, 12px mono values

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: data-model
Evidence:
- repo:src/features/config/config-center.tsx

Decision:
A row is 14px/500 for its name, 12px mono for a displayed value; a group heading is 14px/500. 11px is for
*editable* mono inputs only. jsdom applies no stylesheets, so measure in a browser.

## MC-DEC-20261008-a1000007 — The source drawer is the only editor

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: workflow
Evidence:
- repo:src/features/config/config-center.tsx

Decision:
The centre is one page, not tabs: 适配器 and 原始配置 are gone. A source is edited in its drawer, addressed
via `locateVisualEntry`, never `source.key` — the parser renames or invents it.