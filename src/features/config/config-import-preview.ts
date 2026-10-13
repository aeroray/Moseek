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
    parsed = JSON.parse(configText) as Record<string, unknown>;
  } catch {
    // Already validated by the preview, so this cannot normally happen. Returning the text untouched
    // is the safe direction: an import that keeps more than asked is better than one that fails.
    return configText;
  }

  const deselected = candidates.filter((candidate) => !selectedIds.has(candidate.id));
  const keysToDrop = (kind: ImportCandidate["kind"]) =>
    new Set(deselected.filter((candidate) => candidate.kind === kind).map((c) => c.key));

  const dropSiteKeys = keysToDrop("site");
  const dropLiveKeys = keysToDrop("live");
  const dropParserKeys = keysToDrop("parser");

  for (const section of ["sites", "data"]) {
    const list = parsed[section];
    if (!Array.isArray(list)) continue;
    // Matched on the entry's own `key`, which is what the preview displayed. An entry with no key is
    // kept: it was numbered by the parser from its position, so there is no stable identity to match
    // and dropping the wrong entry is worse than keeping one the user unticked.
    parsed[section] = list.filter((entry) => {
      if (!entry || typeof entry !== "object") return true;
      const key = (entry as Record<string, unknown>).key;
      return typeof key !== "string" || !dropSiteKeys.has(key);
    });
  }

  if (Array.isArray(parsed.lives)) {
    parsed.lives = parsed.lives.filter((entry) => {
      if (!entry || typeof entry !== "object") return true;
      const key = (entry as Record<string, unknown>).key;
      return typeof key !== "string" || !dropLiveKeys.has(key);
    });
  }

  if (Array.isArray(parsed.parses)) {
    parsed.parses = (parsed.parses as unknown[]).filter((entry) => {
      // **Only an entry that states its own key can be matched, and one that does not is kept.**
      // The preview numbers a keyless entry by position, but that number is not an identity: it changes
      // when a neighbouring entry is removed, so matching on it would delete a row the user never
      // deselected by name. `sites` and `lives` are treated the same way, and for the same reason.
      if (!entry || typeof entry !== "object") return true;
      const record = entry as Record<string, unknown>;
      const stated = typeof record.key === "string" && record.key ? record.key : record.id;
      return typeof stated !== "string" || !dropParserKeys.has(stated);
    });
  }

  return JSON.stringify(parsed, null, 2);
}
