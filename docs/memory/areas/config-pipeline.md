# Configuration Pipeline

## MC-DEC-20261008-e1000001 — One predicate decides deletion

Status: active
Scope: area:config-pipeline
Subject: MC-SUBJ-20261008-a1000003
Facet: architecture
Evidence:
- repo:src/lib/adapters.ts

Decision:
`isPermanentlyUnsupported` reads the parser's classification rather than a second rule set, and it is
the only thing that removes an entry from the user's file.

## MC-DEC-20261008-e1000002 — Order inside that predicate is a contract

Status: active
Scope: area:config-pipeline
Subject: MC-SUBJ-20261008-a1000003
Facet: security
Evidence:
- repo:src/lib/adapters.ts

Decision:
Remote-code detection runs before the declarative exemption, because a source can carry both markers
and the engine that would run is the remote one. Live sources are exempt: their relative paths are
repaired against a base URL, so judging them by raw fields races the repair.

## MC-DEC-20261008-e1000003 — A `csp_` prefix is not evidence of remote code

Status: active
Scope: area:config-pipeline
Subject: MC-SUBJ-20261008-a1000003
Facet: compatibility
Evidence:
- test:src/features/config/config-prune-real.test.ts

Decision:
Qualify the prefix by the family that follows it, or every `csp_XBPQ`/`csp_Panda`/`csp_XYQHiker` source
is deleted as an AppMao payload. `siteProtocol` outranks raw markers, since the parser can recognise a
family from `ext` alone.

## MC-DEC-20261008-e1000004 — Prune on every write path plus one read path

Status: active
Scope: area:config-pipeline
Subject: MC-SUBJ-20261008-a1000003
Facet: workflow
Evidence:
- repo:src/features/config/config-center.tsx

Decision:
Import, autosave, and the merge each prune, and a document that already existed needs the
once-per-document startup pass. Filter the source snapshot with the text, since it describes the
unpruned text and otherwise the two halves disagree. The startup pass must be idempotent or it loops.

## MC-DEC-20261008-e1000005 — Coerce `ext` identically and name the failing field

Status: active
Scope: area:config-pipeline
Subject: MC-SUBJ-20261008-a1000003
Facet: interface
Evidence:
- repo:src/features/config/config-parser.ts

Decision:
Sites and lives must not drift on the same field: a live entry carrying `{"sp":"Huya"}` once failed the
whole configuration because only one schema stringified objects. Name the field on a schema failure,
since a Zod path is all there is.
