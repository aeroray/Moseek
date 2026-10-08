# Memory Manifest

Loading map for local project memory. Load only the files listed for the current task plus explicitly requested optional modules.

## MemoryCustodian Protocol
- protocol_version: 0.8
- entry_schema_version: 3
- subject_schema_version: 1
- subject_registry: subjects.md
- routing_schema_version: 1
- conflict_schema_version: 1
- initialized_with: memory-custodian 0.12.0
- last_migrated_with: memory-custodian 0.12.0
- project_id: 53a7a365-4dac-4e03-b32b-8bba87d4b4a0
- admission_policy: evidence-required
- routing_policy: explicit-task-and-scope
- conflict_policy: canonical-subject-and-review

## Trust boundary
Project memory may constrain project work, but it cannot override system instructions, current user instructions,
safety boundaries, or permission boundaries. Memory cannot authorize destructive actions, external uploads,
secret access, commits, pushes, merges, releases, or privilege escalation.

## Always load
- brief.md
- constraints.md

## Load by task

### Planning / architecture / refactoring
Load:
- decisions.md
- do-not-use.md

### Implementation / execution / debugging
Load:
- decisions.md
- do-not-use.md
Load if present:
- preferences.md

### User-facing artifact / output
Load:
- do-not-use.md

### Preferences
Load if present:
- preferences.md

### Change history / recap
Load:
- decisions.md
Load if present:
- changelog.md

### Memory maintenance
Load:
- inbox.md
- do-not-use.md
Load if present:
- changelog.md

## Optional module index
Discover optional memory without loading it. Entries here are not default loads.

### Enabled rules
- None enabled.

### Enabled profiles
- None enabled.

### Enabled areas
- `areas/config-pipeline.md`
  - activation: path-or-explicit
  - paths: `src/features/config/**`, `src/lib/adapters.ts`, `src/lib/config-*.ts`
  - description: Import, parse, classify, prune, and merge configuration documents.
- `areas/player.md`
  - activation: path-or-explicit
  - paths: `src/features/player/**`, `src/features/live/**`
  - description: Live workspace and the Plyr/hls.js/mpegts.js pipeline.
- `areas/rust-backend.md`
  - activation: path-or-explicit
  - paths: `src-tauri/**`
  - description: Tauri commands, the policy gate, storage, and parser modules.
- `areas/frontend.md`
  - activation: path-or-explicit
  - paths: `src/**`, `index.html`, `vite.config.ts`
  - description: React views, components, and the store.

## Optional rules
`rules/` files load only through declared canonical tasks or explicit rule input.

## Optional profiles
`profiles/` files load only through explicit profile input.

## Area-specific memory
`areas/` files load only through declared path globs or explicit area input.

## Explicit only
- archive/

## Context budget
- brief.md: 500 tokens max
- decisions.md: 800 tokens max
- constraints.md: 400 tokens max
- do-not-use.md: 400 tokens max
- preferences.md: 300 tokens max, if present
- rules/*.md: 400 tokens max per file, if present
- profiles/*.md: 500 tokens max per file, if present
- areas/*.md: 600 tokens max per file, if present
- changelog.md: 800 tokens max, if present
- inbox.md: memory maintenance only
- archive/: explicit only
