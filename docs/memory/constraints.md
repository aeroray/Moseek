# Constraints

## MC-CON-20261008-c1000001 — No remote code execution

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000002
Facet: security
Evidence:
- user-confirmed

Constraint:
Never execute JavaScript, a JAR, a spider, or a shell command from imported configuration. Run only
declarative families; a source needing a script runtime is refused.

## MC-CON-20261008-c1000002 — One network policy gate

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000005
Facet: security
Evidence:
- repo:src-tauri/src/policy.rs

Constraint:
Every remote fetch passes one Rust gate: public HTTP/HTTPS only, bounded bodies, redirects disabled
except where playback prediction requires them, DNS pinned. Loopback and private ranges stay off by
default.

## MC-CON-20261008-c1000004 — Desktop only

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000001
Facet: interface
Evidence:
- user-confirmed

Constraint:
Desktop only; spend no effort on mobile layouts. Style with Tailwind utilities and shadcn/ui components.

## MC-CON-20261008-c1000006 — Never rewrite files with PowerShell redirection

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000006
Facet: workflow
Evidence:
- user-confirmed

Constraint:
Never write source files with PowerShell `Set-Content`/`Out-File`: they emit a UTF-8 BOM and
double-encode CJK unrecoverably. Use the edit/write tools or Node's `fs.writeFileSync`. Recover with
`git show HEAD:<path>`, never `git checkout --`, which discards uncommitted work.

## MC-CON-20261008-c1000007 — Do not move another author's work

Status: active
Scope: project
Subject: MC-SUBJ-20261008-a1000006
Facet: behavior
Evidence:
- user-confirmed

Constraint:
Never isolate a gate run by stashing another author's uncommitted files; let each line commit.