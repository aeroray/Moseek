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
A poster starts with no address, and an `<img>` without `src` paints the broken-image glyph. A
transparent pixel holds its place, and its `load` event is swallowed so callers do not think the
artwork arrived.

## MC-DEC-20261008-a1000003 — Scroll roots need explicit type and min-height

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: behavior
Evidence:
- repo:src/components/ui

Decision:
Every `ScrollArea` that must advertise itself needs `type="auto"` (Radix defaults to `hover`), and every
flex-item scroll root needs `min-h-0` or it grows to its content and nothing scrolls.

## MC-DEC-20261008-a1000004 — Size geometry must not use `data-[size]` padding variants

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: compatibility
Evidence:
- test:src/components/ui/ui-primitives.test.tsx

Decision:
`data-[size=*]:px-*` outranks a caller's `pl-8`, and tailwind-merge cannot reconcile different utility
groups. Emit size geometry as plain classes and split left/right padding.

## MC-DEC-20261008-a1000005 — Overlays tint the icon, not the panel

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: architecture
Evidence:
- repo:src/components/ui/toast.tsx

Decision:
A toast body stays on `bg-card/95` with `shadow-xl backdrop-blur-md`; only the icon carries the status
colour. `--status-*-bg` is a badge tint — a 12% fill across a 24rem panel reads as another application.

## MC-DEC-20261008-a1000006 — One type scale: 14/500 names, 12px mono values

Status: active
Scope: area:frontend
Subject: MC-SUBJ-20261008-a1000008
Facet: data-model
Evidence:
- repo:src/features/config/config-center.tsx

Decision:
A row reads 14px/500 for its name and 12px mono for a displayed value; a group heading is 14px/500. 11px
is for *editable* mono inputs only. Measured in a real browser — jsdom applies no stylesheets, so pin the
classes and measure the rendering.
