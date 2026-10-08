import { mergeSourceLists } from "@/features/config/config-merge";
import type { ParseResult } from "@/features/config/config-parser";
import { isPermanentlyUnsupportedSource } from "@/lib/adapters";
import type { SourceRecord } from "@/types/moseek";

/**
 * What a save should write, given whatever the editor currently holds.
 *
 * The rule the user asked for: **the text is always saved, valid or not.** Editing a configuration is
 * the user's own work, and a validation failure is a statement about our parser, not a reason to
 * discard what they typed. The old flow refused the save outright — "配置无法保存，请先修正" — which
 * meant a single mistyped character could cost an entire session's edits, and it also meant a
 * configuration the app itself could not read could never be corrected from inside the app.
 *
 * So the text always lands. What varies is the DERIVED state:
 *
 * - Parseable: the source list is merged and the normalised form is regenerated, as before.
 * - Unparseable: there is nothing to derive from, so the previous derived state is kept. The
 *   alternative — writing empty sources and an empty normalised form — would make a typo look like
 *   deleting every source, which is far worse than a stale list and is exactly the "silently emptied
 *   my configuration" failure this file's other rules exist to prevent.
 *
 * `warning` carries the parse problem back to the caller, so the user is told immediately without
 * being blocked. It is null when the text parsed.
 */
export interface SavePayload {
  rawConfig: string;
  normalizedConfig: string;
  sources: SourceRecord[];
  liveCount: number;
  /** The parse problem to report, or null when the text parsed cleanly. */
  warning: string | null;
  /** How many sources the list holds after this save, for the confirmation message. */
  sourceCount: number;
}

export function resolveSavePayload({
  text,
  parsed,
  previousSources,
  previousNormalizedConfig,
  previousLiveCount,
}: {
  text: string;
  parsed: ParseResult | null;
  previousSources: SourceRecord[];
  previousNormalizedConfig: string;
  previousLiveCount: number;
}): SavePayload {
  // `parsed` is null only for empty text. An empty configuration is a legitimate state — the user
  // cleared the file — and it means "no sources" rather than "keep the old ones", so it takes the
  // derived path with an empty result instead of the keep-the-previous path.
  if (parsed?.ok) {
    // The merged list is filtered, because the text reaching here has already been pruned by
    // `pruneUnsupportedConfigText` while `previousSources` may still hold entries from a document
    // written before that rule existed. Without this the list and the file disagree: rows would
    // remain on screen for entries the text no longer contains.
    const merged = mergeSourceLists(previousSources, parsed.sources, true)
      .sources.filter((source) => !isPermanentlyUnsupportedSource(source));
    return {
      rawConfig: text,
      normalizedConfig: parsed.normalizedConfig,
      sources: merged,
      liveCount: parsed.liveCount,
      warning: null,
      sourceCount: merged.length,
    };
  }

  if (parsed === null) {
    return {
      rawConfig: text,
      normalizedConfig: JSON.stringify({ schemaVersion: "0.2", sites: [], lives: [], parses: [] }, null, 2),
      sources: [],
      liveCount: 0,
      warning: null,
      sourceCount: 0,
    };
  }

  // Unparseable. The text still lands; the derived state stays as it was.
  const issue = parsed.issues[0];
  const location = issue?.line ? `（第 ${issue.line} 行）` : "";
  return {
    rawConfig: text,
    normalizedConfig: previousNormalizedConfig,
    sources: previousSources,
    liveCount: previousLiveCount,
    warning: `已保存，但这段配置暂时无法解析${location}：${issue?.message ?? "未知错误"}。源列表仍显示上一次解析成功的结果。`,
    sourceCount: previousSources.length,
  };
}
