# Configuration Schema

What an incoming configuration file may contain, and how an unfamiliar shape is accepted rather than
rejected.

## MC-DEC-20261008-e1000005 — Coerce `ext` identically and name the failing field

Status: active
Scope: area:config-schema
Subject: MC-SUBJ-20261008-a1000003
Facet: interface
Evidence:
- repo:src/features/config/config-parser.ts

Decision:
Sites and lives must not drift on the same field: a live entry carrying `{"sp":"Huya"}` once failed the
whole configuration, because only one schema stringified objects. Name the failing field — a Zod path is
all there is.

## MC-DEC-20261008-e1000007 — `null` means absent, everywhere in the schema

Status: active
Scope: area:config-schema
Subject: MC-SUBJ-20261008-a1000003
Facet: data-model
Evidence:
- repo:src/features/config/config-schema.ts

Decision:
One preprocess normalises `null` to `undefined` for every optional field. `.optional()` accepts only a
missing key, but the exporter serialises source records, so Moseek could not re-import its own export.
Fix the pattern, not the one field reported.

## MC-DEC-20261008-b1000004 — Export rebuilds from the list, not a stored snapshot

Status: active
Scope: area:config-schema
Subject: MC-SUBJ-20261008-a1000003
Facet: lifecycle
Evidence:
- repo:src/features/config/config-export.ts

Decision:
`buildExportConfigText` derives `sites`/`lives` from `sources` at write time. The stored
`normalizedConfig` is maintained separately and drifts, so the file described a different set from the
list. Keep every other top-level key.

## MC-DEC-20261008-b1000005 — A configuration carries resources only

Status: active
Scope: area:config-schema
Subject: MC-SUBJ-20261008-a1000003
Facet: architecture
Evidence:
- repo:src/features/settings/app-data-file.ts

Decision:
Favourites and the theme move through 设置 as `moseek-data.json`; a configuration never carries them.
`moseek`, `schemaVersion`, `configDialect` and `blockedFields` are excluded from the visual editor's
其他设置. The legacy `moseek` reader stays, for old exports.

## MC-DEC-20261008-b1000006 — Read a live entry's `channels` lines

Status: active
Scope: area:config-schema
Subject: MC-SUBJ-20261008-a1000003
Facet: behavior
Evidence:
- repo:src/features/config/config-parser.ts

Decision:
A live entry may use `channels[].urls[]` rather than `url`: take the first line yielding an `http(s)`
address, decoding `proxy://do=live&ext=<base64>`. Keep the field unmodelled.
