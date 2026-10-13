import { parseConfigText, pruneUnsupportedConfigText } from "@/features/config/config-parser";
import type { ParseIssue, ParseResult } from "@/features/config/config-parser";
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
  /** Whether this entry can run once imported. Unusable entries are still listed, never hidden. */
  usable: boolean;
  /** Why it cannot run, when it cannot. */
  note: string;
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
  counts: { total: number; usable: number; unusable: number };
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
    counts: { total: 0, usable: 0, unusable: 0 },
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
    counts: { total: candidates.length, usable, unusable: candidates.length - usable },
  };
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
    usable: source.capability === "supported",
    note: source.capability === "supported" ? "" : source.capabilityNote,
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
