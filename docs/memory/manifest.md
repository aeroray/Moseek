# Memory Manifest

protocol_version: 1
initialized_with: memory-custodian
last_migrated_with: memory-custodian

## Default Context

- `brief.md`

## Task Routes

- general continuation: `brief.md`
- planning: `brief.md`, `decisions.md`, `constraints.md`, `do-not-use.md`
- implementation: `brief.md`, `decisions.md`, `constraints.md`, `do-not-use.md`
- artifact work: `brief.md`, `do-not-use.md`
- preferences: `brief.md`
- history: `brief.md`, `decisions.md`
- maintenance: `brief.md`, `manifest.md`, `inbox.md`

## Optional Module Index

No optional rules, profiles, or areas are enabled.

## Loading Rules

- Load `inbox.md` only for maintenance, compaction, auditing, or an explicit request.
- Load `archive/` only for archive maintenance or an explicit request.
- Current user instructions override memory; safety and hard constraints override preferences.

## Context Budgets

- `brief.md`: 500 tokens
- `decisions.md`: 800 tokens
- `constraints.md`: 400 tokens
- `do-not-use.md`: 400 tokens
- `inbox.md`: no default load
