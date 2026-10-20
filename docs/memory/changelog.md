# Changelog

Durable outcomes of work that changed the project's contract. Loaded for "change history / recap".

## What belongs under `docs/`

The test is **"does something break if this file is missing"**, not "is it documentation".

| Path | Tracked | Why |
|---|---|---|
| `memory/` | yes | `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` tell every agent to read it. |
| `releases/<tag>.md` | yes | **Build input** — `load-release-notes.mjs` fails the release when absent. |
| `images/` | yes | Both READMEs embed `docs/images/library.png`. |
| `releasing.md` | yes | Release procedure. Fixed by removing its secret, not the file. |
| `reviews/` | **no** | Stale once fixed; quotes replaced vulnerable code. |

Memory is *current truth* agents load on purpose; a review is *evidence about a past state*.

## 2026-10-19 — Full-tree review and its fixes

**Two headline features had never worked.** 「接着看」gated its seek on `player.duration` inside
Plyr's `ready` (fires before media; duration getter maps `NaN`/`Infinity` to `0`). 重试 bumped a token
absent from the resolve effect's dependencies. **Both sat behind tests asserting a control exists
rather than that it works — a feature whose test only proves rendering is not tested.**

**The WebView was fetching media itself** — the native `<video>` branch assigned `source.url`
directly, so the element resolved DNS and followed redirects outside the policy. Now gated by
`resolve_media_element_url`; partial only, since the element can still be redirected later. The
complete answer is a `moseek-media://` scheme handler forwarding `Range`.

**Three "silently half-applies" bugs, one shape:** a helper returns its input unchanged when it
cannot parse it, and the caller commits anyway. Stored raw text is JSON5, so strict `serde_json`
fails on real documents. **A mutation that cannot rewrite every representation must refuse, not
apply to one of them.** The same divergence let `keepSelectedEntries` (`JSON.parse`) ignore unticking
in a JSON5 document the preview (`JSON5.parse`) showed.

**`capability` is derived, never stored** (`MC-DEC-20261008-3b9c0ef4`). Two repair paths wrote it from
a URL shape, re-enabling sources the user switched off and erasing probe history. `enabled` is user
intent; no automatic pass may set it.

**Discovered:** quick-xml ≥0.39 emits `&amp;` as `Event::GeneralRef`, so a parser handling only
Start/Text/CData/End truncates every field at each `&`. GB18030 accepts Big5 bytes, so "it decoded"
is not proof it decoded correctly.

**Removed:** `sniff_with_companion` and `opener:default` (both uncalled).

**Process:** `policy.rs` was once corrupted by `Set-Content -Encoding utf8`, which
`MC-CON-20261008-c1000006` forbids. Recovered via `git show HEAD:` plus replay.
