# Configuration Schema

What an incoming configuration file is allowed to contain, and how a shape that is merely unfamiliar
is accepted rather than rejected.

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
