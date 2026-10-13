import JSON5 from "json5";

import { EXPORT_EXTRAS_KEY } from "@/features/config/config-extras";
import type { SourceRecord } from "@/types/moseek";

/**
 * Builds the configuration text to export, from the list the user is actually looking at.
 *
 * **Why this exists.** The export wrote the stored `normalizedConfig` string, while the list renders
 * `sources` — two values maintained separately. When they drift, the file silently describes a
 * different set of sources from the one on screen. Reported as "导出前 60 个，重新导入后 55 个": the
 * exported file held 55 while the header and the list showed 60. Importing it losslessly produced 55,
 * so the loss had already happened at export time and nothing said so.
 *
 * Deriving `sites` and `lives` from `sources` at the moment of writing makes the two agree by
 * construction, which is the only kind of fix that cannot drift again.
 *
 * **Everything other than `sites` and `lives` is preserved from the stored document.** `parses`,
 * `blockedFields`, `configDialect` and any key a TVBox client added are not represented in `sources`
 * at all, so rebuilding the whole object from the list would drop them. That is also why the stored
 * text is parsed rather than regenerated.
 *
 * The entries keep the shape the previous export produced — the parsed record with its adapter fields
 * — because that is what the file already contained and what other clients already accept. Changing
 * the shape is a separate decision from fixing the count.
 */
export function buildExportConfigText(
  storedText: string,
  sources: SourceRecord[],
): string {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON5.parse(storedText);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // An unreadable stored document is not a reason to refuse the export: the list is intact and the
    // user asked for a file. The configuration below is written from the list alone.
  }

  const sites = sources.filter((source) => source.sourceType !== "live");
  const lives = sources.filter((source) => source.sourceType === "live");

  // **The app's own data key is dropped here as well as on import.** A stored document that still
  // carries it — one imported before the split, or hand-edited — must not put it back into a file the
  // user sends elsewhere. Export and import both strip it, because either side alone lets the key
  // through in one direction.
  const configOnly = { ...parsed };
  delete configOnly[EXPORT_EXTRAS_KEY];

  return JSON.stringify(
    {
      ...configOnly,
      schemaVersion: "0.2",
      configDialect: configOnly.configDialect ?? "tvbox",
      sites,
      lives,
      // `parses` is kept from the stored document. It is not a source list, so it cannot drift the way
      // the two above could, and the parser services a user sees are the ones the stored text holds.
      parses: Array.isArray(configOnly.parses) ? configOnly.parses : [],
    },
    null,
    2,
  );
}
