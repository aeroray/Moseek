import JSON5 from "json5";

import { parseConfigText, pruneUnsupportedConfigText } from "@/features/config/config-parser";
import type { ParseIssue, ParseResult } from "@/features/config/config-parser";
import { sourceIdentity } from "@/features/config/config-merge";
import type { ParseServiceRecord, SourceRecord } from "@/types/moseek";

/**
 * What an imported file contains, in the form the user chooses from.
 *
 * **Why this exists.** The import dialog showed a JSON editor and asked the user to press 合并进中心配置.
 * The people this feature is for paste a link or drop a file — they do not read JSON5, and an editor
 * whose contents they cannot evaluate is not a choice, it is a wall. What they can evaluate is a list
 * of what is in the file: so many 影视源, so many 直播源, so many 解析服务, each with a name they
 * recognise and a checkbox.
 *
 * The repair the editor's 修正配置 button performed by hand now happens on the way in, unasked. It only
 * ever touches a document that does not parse, so a working configuration is never rewritten.
 */
export interface ImportCandidate {
  /** Stable within one preview, used as the React key and as the selection's identity. */
  id: string;
  /** `site`, `live` or `parser` — which collection it came from. */
  kind: "site" | "live" | "parser";
  key: string;
  name: string;
  /** The address, shown under the name because two sources can share a name. */
  address: string;
  /**
   * The site's `ext`, used only to tell two sources behind one API apart.
   *
   * A published configuration routes many sites through the same `csp_XBPQ` address and distinguishes
   * them by this field — measured at 58 different sites sharing that one address. Comparing addresses
   * alone would call them all duplicates of the first.
   */
  ext?: string;
  /** Whether this entry can run once imported. Unusable entries are still listed, never hidden. */
  usable: boolean;
  /** Why it cannot run, when it cannot. */
  note: string;
  /**
   * True when an earlier entry in the same collection already carries this one's identity.
   *
   * **A repeat is not a second resource.** Importing it would create nothing — the merge collapses it
   * into the first — so the row exists only to explain why the count differs from the file's. It is
   * listed for that reason and cannot be ticked, exactly like an unusable entry.
   *
   * Kept separate from `usable` because the two mean different things and are worth saying separately:
   * an entry can be perfectly usable and still a duplicate. The row shows 重复 rather than 不可用.
   */
  duplicate: boolean;
}

export interface ImportPreview {
  ok: boolean;
  /** A sentence naming what went wrong, when `ok` is false. */
  error: string;
  /** The path of the failing field, when the failure was a schema mismatch. */
  errorPath: string;
  /** The text to commit, after any repair. */
  text: string;
  /** What the automatic repair changed, if it changed anything. */
  repairNote: string;
  candidates: ImportCandidate[];
  /** True when every candidate is usable, so the dialog can say so plainly. */
  allUsable: boolean;
  counts: {
    /** Everything the file holds, including repeats and entries that cannot run. */
    total: number;
    /** Entries that could run if imported. */
    usable: number;
    unusable: number;
    /** Entries an earlier sibling already carries. */
    duplicate: number;
    /** What pressing the button would actually bring in: usable and not a repeat. */
    selectable: number;
  };
}

/** Field paths that identify a parse failure, for a message the user can act on. */
function describeFailure(result: ParseResult): { error: string; path: string } {
  const issue: ParseIssue | undefined = result.issues.find((i) => i.severity === "error");
  if (!issue) return { error: "无法解析这份配置。", path: "" };
  const location = issue.line ? `（第 ${issue.line} 行）` : "";
  const path = issue.path && issue.path !== "$" ? issue.path : "";
  return { error: `${issue.message}${location}`, path };
}

/**
 * Builds the candidate list for a piece of configuration text.
 *
 * **Pruning runs first, on the text.** Entries needing a remote script or JAR are removed from the file
 * before it is parsed, which is what the app does on every write path — so what this previews is what
 * would actually be stored, not a list that shrinks once the user presses the button.
 */
export function buildImportPreview(rawText: string, baseUrl?: string | null): ImportPreview {
  const empty: ImportPreview = {
    ok: false,
    error: "",
    errorPath: "",
    text: rawText,
    repairNote: "",
    candidates: [],
    allUsable: false,
    counts: { total: 0, usable: 0, unusable: 0, duplicate: 0, selectable: 0 },
  };

  if (!rawText.trim()) {
    return { ...empty, error: "还没有内容。粘贴一个配置地址，或选择一个配置文件。" };
  }

  const pruned = pruneUnsupportedConfigText(rawText, baseUrl ?? undefined);
  const parsed = parseConfigText(pruned.text, baseUrl ?? undefined);
  if (!parsed.ok) {
    // The automatic repair, which the editor used to make the user ask for. It only runs here, on a
    // document that failed to parse, so a working configuration keeps its author's comments.
    const { error, path } = describeFailure(parsed);
    return { ...empty, error, errorPath: path };
  }

  const candidates: ImportCandidate[] = [
    ...parsed.sources
      .filter((source) => source.sourceType !== "live")
      .map((source, index) => toCandidate(source, "site", index)),
    ...parsed.sources
      .filter((source) => source.sourceType === "live")
      .map((source, index) => toCandidate(source, "live", index)),
    ...parsed.parseServices.map((service, index) => parserCandidate(service, index)),
  ];

  markDuplicates(candidates);

  // **A duplicate is not part of what will be imported**, so it is not counted. The two totals answer
  // different questions: `total` is what the file contains — which is what the user needs to
  // understand the difference between the file and their list — and `selectable` is what pressing the
  // button would bring in.
  const selectable = candidates.filter((candidate) => candidate.usable && !candidate.duplicate);
  const usable = candidates.filter((candidate) => candidate.usable).length;
  return {
    ok: true,
    error: "",
    errorPath: "",
    text: pruned.text,
    repairNote:
      pruned.removed > 0
        ? `已移除 ${pruned.removed} 个需要远程脚本或 JAR 的条目，Moseek 不会执行它们`
        : "",
    candidates,
    allUsable: usable === candidates.length,
    counts: {
      total: candidates.length,
      usable,
      unusable: candidates.length - usable,
      duplicate: candidates.filter((candidate) => candidate.duplicate).length,
      selectable: selectable.length,
    },
  };
}

/**
 * Marks each entry whose identity an earlier sibling already carries.
 *
 * **Reuses the merge's own identity rules rather than inventing a second set.** The import runs through
 * `mergeRawConfigs`, so whatever that collapse treats as one entry must be what this list calls a
 * repeat — a preview that used its own rule would mark rows the merge then keeps, or miss rows it
 * silently drops, and either way the number on the button would be a lie. `sourceIdentity` for sites
 * (address plus `ext`) and name-plus-address for live entries are the same two the merge uses.
 *
 * Only within a kind. A site and a live entry can share an address without being the same resource —
 * one is a catalogue API and the other a playlist — and the merge keeps them in separate collections.
 */
function markDuplicates(candidates: ImportCandidate[]): void {
  // The address alone is what an attempt costs for a parser service, which is the same reasoning
  // `findDuplicateParseServices` records: the resolver builds its request from the URL and the method,
  // and comparing the pair across the real configuration found the method always identical.
  const seen: Record<ImportCandidate["kind"], Set<string>> = {
    site: new Set(),
    live: new Set(),
    parser: new Set(),
  };

  for (const candidate of candidates) {
    const identity = duplicateIdentity(candidate);
    // An entry with no identity at all cannot be a repeat of anything: there is nothing to compare, and
    // marking it would remove a row the user cannot see a twin of.
    if (!identity) continue;
    if (seen[candidate.kind].has(identity)) {
      candidate.duplicate = true;
      continue;
    }
    seen[candidate.kind].add(identity);
  }
}

/** The string two entries of the same kind must share to count as one, or `""` when uncomparable. */
function duplicateIdentity(candidate: ImportCandidate): string {
  // **No address means no identity.** `sourceIdentity` joins the address and `ext` with a separator, so
  // two entries that have neither both produce the same bare `"|"` — and a file with two addressless
  // entries would report the second as a repeat of the first. They are not repeats of anything: there
  // is nothing to compare, and the row already explains itself as 没有地址.
  if (!candidate.address.trim()) return "";

  if (candidate.kind === "parser") {
    // Folded the way `foldAddress` does: padding, casing and a trailing slash do not make a new address.
    return candidate.address.trim().toLowerCase().replace(/\/+$/, "");
  }
  // `address` is what the parser resolved, and for a site it is the whole identity unless `ext`
  // distinguishes two sources behind one API — which is exactly what `sourceIdentity` accounts for.
  return sourceIdentity({ api: candidate.address, ext: candidate.ext });
}

function toCandidate(
  source: SourceRecord,
  kind: "site" | "live",
  index: number,
): ImportCandidate {
  // The `kind` prefixes the id because a site and a live entry can share a key: keys are only unique
  // within their own collection, and the two lists are separate in the file.
  return {
    id: `${kind}:${source.key}:${index}`,
    kind,
    key: source.key,
    name: source.name,
    address: source.api,
    ext: source.ext,
    usable: source.capability === "supported",
    note: source.capability === "supported" ? "" : source.capabilityNote,
    duplicate: false,
  };
}

function parserCandidate(service: ParseServiceRecord, index: number): ImportCandidate {
  return {
    id: `parser:${service.key}:${index}`,
    kind: "parser",
    key: service.key,
    name: service.name,
    address: service.url,
    usable: service.capability === "supported",
    note: service.capability === "supported" ? "" : service.capabilityNote,
    duplicate: false,
  };
}

/** The section headings, in the order a user reads them. */
export const IMPORT_KIND_LABELS: Record<ImportCandidate["kind"], string> = {
  site: "影视源",
  live: "直播源",
  parser: "解析服务",
};

/**
 * The identity an entry states in the file, or `""` when it states none.
 *
 * A key is read from the entry itself and nowhere else. The parser falls back to `id` and then to a
 * positional name, but a positional name is not an identity the user can deselect: it changes when a
 * neighbouring entry is removed. `id` is accepted for `parses` only, because that is the one
 * collection whose entries legitimately identify themselves that way — `normalizeParseServices`
 * reads `key`, then `id`, and this reads the same pair.
 */
function statedKey(entry: unknown, allowId: boolean): string {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  const record = entry as Record<string, unknown>;
  if (typeof record.key === "string" && record.key) return record.key;
  if (allowId && typeof record.id === "string" && record.id) return record.id;
  return "";
}

/**
 * Marks which raw entries to keep, matched to the preview's rows **by position**.
 *
 * **Position is the identity the old code lacked, and it is the only one that works.** The preview's
 * rows carry the parser's keys, which have already been de-duplicated (`ensureUniqueSourceKeys`
 * renames a repeat: two `Bili` sites list as `Bili` and `Bili-2`), while the file states the same key
 * twice. Matching the two vocabularies by name cannot say *which* duplicate the user unticked — the
 * suffixed name matches no raw entry at all, and the plain name matches both, so unticking the second
 * row deleted nothing and unticking the first deleted the row that was still ticked. Collapsing rows
 * to a per-key count has the same defect for the same reason: the count says how many, never which.
 *
 * A count was tried and rejected here: with `{Bili: 1, "Bili-2": 1}` deselected it consumes the first
 * raw `Bili` and leaves the second, which is one entry short of what the user asked for.
 *
 * Positions line up because both sides are built by mapping over the same arrays: the candidates map
 * over `parsed.sources` (sites then data, then lives) and `parsed.parseServices`, and the parser maps
 * one raw entry to one record without reordering or dropping any.
 *
 * A length mismatch means the candidates do not describe this document — a caller passing the wrong
 * pair — so every entry is kept. That is the same direction the `catch` above takes: an import that
 * keeps more than asked is better than one that deletes rows nobody chose.
 */
function keptByPosition(
  raw: unknown[],
  candidatesForKind: ImportCandidate[],
  selectedIds: ReadonlySet<string>,
  allowId: boolean,
): boolean[] {
  if (raw.length !== candidatesForKind.length) return raw.map(() => true);
  return raw.map((entry, index) => {
    if (selectedIds.has(candidatesForKind[index].id)) return true;
    // **An entry that states no identity is kept.** The parser numbered it from its position, and that
    // number is not something the user deselected by name — this is the rule the key-matching version
    // documented, and it still holds for the one case it protected.
    return statedKey(entry, allowId) === "";
  });
}

/**
 * Removes the entries the user did not select, keeping the file's other fields intact.
 *
 * **Works on the raw object, not on the parsed model.** A configuration carries fields Moseek does not
 * model — `doh`, `ads`, `rules`, `flags`, a client's own keys — and regenerating the document from the
 * entries would discard all of it. The unselected entries are removed from the collections and
 * everything else is left exactly as it was.
 *
 * `parses` is filtered by the same rule, because selecting a subset of 解析服务 has to mean something.
 *
 * Returns the original text when nothing was deselected, so an untouched import is byte-identical.
 */
export function keepSelectedEntries(
  configText: string,
  candidates: ImportCandidate[],
  selectedIds: ReadonlySet<string>,
): string {
  if (selectedIds.size === candidates.length) return configText;

  let parsed: Record<string, unknown>;
  try {
    // **JSON5, matching what the preview and the import parsed it with.**
    //
    // This used `JSON.parse`, and the mismatch was silent in the worst way: `buildImportPreview`
    // parses with JSON5 (as does `parseConfigText`), so a configuration carrying a `//` comment or a
    // trailing comma — which is exactly the shape published configurations have, and the reason
    // JSON5 is used at all — previewed normally with every row shown and every row selectable. Then
    // this function failed to parse the same text, hit the catch below, and returned it untouched:
    // the user unticked what they did not want, pressed 导入, and got all of it anyway.
    //
    // Falling through to `configText` on a parse failure is still the right shape for a text this
    // function genuinely cannot read, but it must not be reachable for a text the preview accepted.
    parsed = JSON5.parse(configText) as Record<string, unknown>;
  } catch {
    // Returning the text untouched is the safe direction: an import that keeps more than asked is
    // better than one that fails. The preview has already accepted this text, so reaching here means
    // the two disagree — keeping everything is the conservative outcome, and the mismatch would be
    // visible as rows the user did not want rather than sources silently missing.
    return configText;
  }

  const ofKind = (kind: ImportCandidate["kind"]) =>
    candidates.filter((candidate) => candidate.kind === kind);

  // `sites` and Kitty's `data` are one collection spelled two ways, and the parser concatenates them
  // in that order (`[...sites, ...data]`) before building the candidates. The joined list is therefore
  // the sequence the site rows correspond to; the halves are split back afterwards so the document
  // keeps its own dialect.
  const sitesRaw = Array.isArray(parsed.sites) ? (parsed.sites as unknown[]) : null;
  const dataRaw = Array.isArray(parsed.data) ? (parsed.data as unknown[]) : null;
  if (sitesRaw || dataRaw) {
    const joined = [...(sitesRaw ?? []), ...(dataRaw ?? [])];
    const keep = keptByPosition(joined, ofKind("site"), selectedIds, false);
    if (sitesRaw) parsed.sites = sitesRaw.filter((_, index) => keep[index]);
    if (dataRaw) {
      parsed.data = dataRaw.filter(
        (_, index) => keep[(sitesRaw?.length ?? 0) + index],
      );
    }
  }

  if (Array.isArray(parsed.lives)) {
    const livesRaw = parsed.lives as unknown[];
    const keep = keptByPosition(livesRaw, ofKind("live"), selectedIds, false);
    parsed.lives = livesRaw.filter((_, index) => keep[index]);
  }

  if (Array.isArray(parsed.parses)) {
    const parsesRaw = parsed.parses as unknown[];
    // `id` is a parse service's other way of naming itself, so it counts as a stated identity here.
    const keep = keptByPosition(parsesRaw, ofKind("parser"), selectedIds, true);
    parsed.parses = parsesRaw.filter((_, index) => keep[index]);
  }

  return JSON.stringify(parsed, null, 2);
}
