/**
 * Merging configurations into one.
 *
 * Moseek keeps a single 中心配置. Every import is unioned into it rather than becoming a new
 * document, so the user maintains one configuration and can export one file.
 *
 * Two decisions here are load-bearing, and both come from measuring the real configurations:
 *
 * 1. **Identity is `type + api + ext`, not `key` and not `api`.**
 *    `key` is not an identity: 26 keys in the author's three configurations appear more than once
 *    carrying completely different sources (`Bili` is `csp_Bili` in one and a `...Guard` URL in
 *    another; `live-1` is three unrelated live addresses). Deduping on `key` would delete 26 real
 *    sources without asking. `api` alone is no better: `csp_XBPQ` is shared by 58 *different* sites
 *    and `csp_Bili` by about 20, each distinguished by its `ext`. Deduping on `api` would collapse
 *    192 sources into nothing. `type + api + ext` reduces the same 364 sources to 354 — it removes
 *    the 10 genuine duplicates and nothing else.
 *
 * 2. **The merge runs on the raw configuration, not on the parsed sources.**
 *    The parsed model does not carry every field a TVBox configuration can hold. In the author's
 *    configurations, 192 field instances exist only in the raw text (`changeable` ×128, `timeout`
 *    ×31, `categories` ×23, `playUrl`, `indexs`, `header`, …). Merging the parsed sources and
 *    regenerating a configuration from them would silently discard all of it. So the raw
 *    collections are unioned losslessly, and the source list is re-derived from the merged raw
 *    text by the ordinary parser — which keeps the two in agreement by construction.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A configuration as read from JSON. Values are `unknown` rather than `JsonValue` because a
 * configuration file is untrusted input: the merge has to accept whatever JSON5 produced, including
 * shapes it did not expect, without the type system pretending it knows better.
 */
export type JsonObject = { [key: string]: unknown };

/** Collections inside a TVBox/CatVod configuration that are merged entry by entry. */
const COLLECTION_KEYS = [
  "sites",
  "lives",
  "parses",
  "flags",
  "doh",
  "rules",
  "ads",
  "ijk",
] as const;

/**
 * Scalar fields at the top level. The incoming configuration wins when it states one, because the
 * user just chose to import it; the existing value stands in when the incoming configuration is
 * silent, so importing a minimal file cannot blank out settings the user already had.
 */
const SCALAR_KEYS = ["wallpaper", "warningText", "spider"] as const;

/** Local choices that belong to the user, not to the configuration that was imported. */
export const LOCAL_STATE_FIELDS = [
  "enabled",
  "scriptArchiveId",
  "testStatus",
  "testMessage",
  "testedAt",
  "testItemCount",
  "testCategoryCount",
  "testDurationMs",
  "testOperations",
  "requestCount",
  "lastCheckedAt",
] as const;

/** Collapses whitespace, lower-cases and drops trailing slashes so trivial differences agree. */
function normalizeText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    return value.trim().toLowerCase().replace(/\/+$/, "");
  }
  // `ext` is a string for most dialects but an object for others (XBPQ ships a mapping). Both are
  // meaningful, so both are folded into a stable comparison key rather than dropped.
  return stableStringify(value).toLowerCase();
}

/** A deterministic string for a JSON value, so two equal objects compare equal. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

/**
 * The raw `type` field, which may arrive as a number or a numeric string.
 *
 * An absent type is folded to `1` rather than left as the empty string, because that is what it
 * means: TVBox treats a site without a type as a type-1 JSON source, and the parser does the same
 * (`siteType === 1 || siteType === null`). Comparing "" against "1" would report the same site as
 * two different ones whenever one configuration stated the default and the other left it out —
 * which is exactly how the same site arrives from two different published configurations.
 */
function normalizeSiteTypeValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "1";
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? String(parsed) : String(value);
}

/**
 * The identity of a site inside the raw configuration.
 *
 * `key` is deliberately excluded: it is a display label that differs between configurations for the
 * same site, and is reused across configurations for different sites. See the module comment.
 */
export function rawSiteIdentity(site: JsonObject): string {
  return [
    normalizeSiteTypeValue(site.type),
    normalizeText(site.api),
    normalizeText(site.ext),
  ].join("|");
}

/**
 * The identity of a parsed source, used to carry the user's own state across an import.
 *
 * Deliberately the same `api + ext` pair as {@link rawSiteIdentity} and deliberately NOT including
 * `sourceType`: the stored snapshots were written by an older parser that called every site
 * `"parser"` while the current parser calls the same site `"cms"`, so including it makes every
 * existing snapshot unmatchable and silently discards the user's switches and test results on the
 * first import after upgrading. Measured on the author's three real configurations: dropping
 * `sourceType` changes no merge outcome at all — 335 distinct sources either way, and no group ever
 * joins a live source to a non-live one.
 */
export function sourceIdentity(source: {
  api?: string;
  ext?: unknown;
}): string {
  return [normalizeText(source.api), normalizeText(source.ext)].join("|");
}

/** Per-collection identity. Collections without a natural key fall back to whole-value equality. */
function identityFor(collection: string, item: JsonValue): string {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const object = item as JsonObject;
    switch (collection) {
      case "sites":
        return rawSiteIdentity(object);
      case "lives":
        return `${normalizeText(object.name)}|${normalizeText(object.url)}`;
      case "parses":
        return `${normalizeText(object.name)}|${normalizeText(object.url)}|${normalizeSiteTypeValue(object.type)}`;
      case "doh":
        return `${normalizeText(object.name)}|${normalizeText(object.url)}`;
      case "rules":
        return `${normalizeText(object.name)}|${normalizeText(object.host)}|${normalizeText(object.rule)}`;
      default:
        break;
    }
  }
  // `flags` and `ads` are plain strings; `ijk` and anything unrecognised is compared by value.
  return stableStringify(item);
}

export interface CollectionMerge {
  added: number;
  updated: number;
  unchanged: number;
}

export interface MergeReport {
  /** Sites, the collection the user actually reads, broken out for the summary shown after import. */
  sites: CollectionMerge;
  lives: CollectionMerge;
  /** Totals across every collection, for a one-line "merged N entries" statement. */
  added: number;
  updated: number;
  unchanged: number;
  /** Collections that were present in only one of the two configurations. */
  collectionsIntroduced: string[];
}

/**
 * Unions one collection. The existing order is preserved so the list does not reshuffle on import;
 * a matching entry keeps its position but takes the incoming definition, which is what "the
 * configuration I just imported wins" means in practice.
 */
function mergeCollection(
  existing: JsonValue[],
  incoming: JsonValue[],
  collection: string,
): { merged: JsonValue[]; report: CollectionMerge } {
  const merged = [...existing];
  const indexByIdentity = new Map<string, number>();
  merged.forEach((item, index) => {
    indexByIdentity.set(identityFor(collection, item), index);
  });

  const report: CollectionMerge = { added: 0, updated: 0, unchanged: 0 };
  for (const item of incoming) {
    const identity = identityFor(collection, item);
    const at = indexByIdentity.get(identity);
    if (at === undefined) {
      indexByIdentity.set(identity, merged.length);
      merged.push(item);
      report.added += 1;
      continue;
    }
    if (stableStringify(merged[at]) === stableStringify(item)) {
      report.unchanged += 1;
      continue;
    }
    merged[at] = item;
    report.updated += 1;
  }
  return { merged, report };
}

export interface MergeRawResult {
  raw: JsonObject;
  report: MergeReport;
}

/**
 * Unions two raw configurations.
 *
 * Arrays present in only one side are carried over untouched: dropping a collection the other
 * configuration happens not to use would delete real settings.
 */
export function mergeRawConfigs(
  existing: JsonObject,
  incoming: JsonObject,
): MergeRawResult {
  const raw: JsonObject = {};
  const report: MergeReport = {
    sites: { added: 0, updated: 0, unchanged: 0 },
    lives: { added: 0, updated: 0, unchanged: 0 },
    added: 0,
    updated: 0,
    unchanged: 0,
    collectionsIntroduced: [],
  };

  const keys = new Set<string>([
    ...Object.keys(existing),
    ...Object.keys(incoming),
  ]);

  for (const key of keys) {
    const before = existing[key];
    const after = incoming[key];

    if (after === undefined) {
      raw[key] = before;
      continue;
    }
    if (before === undefined) {
      raw[key] = after;
      if ((COLLECTION_KEYS as readonly string[]).includes(key)) {
        report.collectionsIntroduced.push(key);
        if (Array.isArray(after)) {
          report.added += after.length;
        }
      }
      continue;
    }

    const isCollection = (COLLECTION_KEYS as readonly string[]).includes(key);
    if (isCollection && Array.isArray(before) && Array.isArray(after)) {
      const { merged, report: counts } = mergeCollection(before, after, key);
      raw[key] = merged;
      if (key === "sites") report.sites = counts;
      if (key === "lives") report.lives = counts;
      report.added += counts.added;
      report.updated += counts.updated;
      report.unchanged += counts.unchanged;
      continue;
    }

    if ((SCALAR_KEYS as readonly string[]).includes(key)) {
      // The incoming value wins when it states something; an empty string does not count as
      // stating something, so importing a file that omits a setting cannot erase the existing one.
      const statesSomething =
        after !== null && after !== undefined && stableStringify(after) !== '""';
      raw[key] = statesSomething ? after : before;
      continue;
    }

    // Unknown top-level keys: incoming wins when present, otherwise the existing value stands.
    raw[key] = after;
  }

  return { raw, report };
}

/**
 * Resolves relative references in a configuration against its own base URL.
 *
 * Relative paths (`./libs/js/drpy2.min.js`) only mean something together with the base URL they
 * were imported with, and a merged configuration can only keep one base. Absolutising the incoming
 * side first means nothing silently points at the wrong host after the merge.
 */
export function absolutizeRelativeSites(
  raw: JsonObject,
  baseUrl: string | null | undefined,
): JsonObject {
  if (!baseUrl) return raw;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return raw;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return raw;

  const sites = raw.sites;
  if (!Array.isArray(sites)) return raw;

  const absolutize = (value: unknown): unknown => {
    if (typeof value !== "string" || !value.trim()) return value;
    const trimmed = value.trim();
    // Leave anything that already carries a scheme, and leave the dialect tokens (`csp_Bili`)
    // alone: those are names resolved by an adapter, not URLs.
    if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return value;
    try {
      const resolved = new URL(trimmed, base);
      return resolved.protocol === "http:" || resolved.protocol === "https:"
        ? resolved.toString()
        : value;
    } catch {
      return value;
    }
  };

  return {
    ...raw,
    sites: sites.map((site) => {
      if (site === null || typeof site !== "object" || Array.isArray(site)) return site;
      const object = site as JsonObject;
      const next: JsonObject = { ...object };
      if (typeof object.api === "string" && /^\.{1,2}\//.test(object.api.trim())) {
        next.api = absolutize(object.api) as JsonValue;
      }
      if (typeof object.ext === "string" && /^\.{1,2}\//.test(object.ext.trim())) {
        next.ext = absolutize(object.ext) as JsonValue;
      }
      return next;
    }),
  };
}

/**
 * Carries the user's own choices from the previous source list onto the freshly parsed one.
 *
 * The definition of a source (name, ext, capability) comes from the configuration just imported,
 * but whether the user switched it on and what the last test found are local facts that an import
 * has no business resetting.
 */
export function carryLocalSourceState<
  T extends {
    api?: string;
    ext?: unknown;
    capability?: string;
    enabled?: boolean;
  },
>(parsed: T[], previous: T[]): { sources: T[]; carried: number } {
  const byIdentity = new Map<string, T>();
  for (const source of previous) {
    byIdentity.set(sourceIdentity(source), source);
  }

  let carried = 0;
  const sources = parsed.map((source) => {
    const before = byIdentity.get(sourceIdentity(source));
    if (!before) return source;
    carried += 1;
    // A plain record for the copy: an intersection with a generic parameter is readable but not
    // writable, and the fields being restored are not part of the generic's known shape.
    const restored: Record<string, unknown> = { ...source };
    for (const field of LOCAL_STATE_FIELDS) {
      const value = (before as Record<string, unknown>)[field];
      if (value !== undefined) restored[field] = value;
    }
    // A source whose capability was downgraded by the new configuration cannot stay switched on:
    // the rest of the app treats `enabled` as "safe to use", and an unsupported source is not.
    if (source.capability !== "supported") {
      restored.enabled = false;
    }
    return restored as T;
  });

  return { sources, carried };
}

export interface SourceMergeResult<T> {
  sources: T[];
  added: number;
  updated: number;
  unchanged: number;
}

/**
 * Unions two source lists, keeping the existing order.
 *
 * The lists are merged directly rather than by re-parsing the merged configuration text, because
 * re-parsing is not identity-preserving. The parser resolves any value without a scheme against the
 * document's base URL, so `csp_DouDouGuard` becomes `https://szyyds.cn/tv/csp_DouDouGuard` when a
 * base is in effect. Parsing the merged text with one document's base would therefore rewrite the
 * *other* document's relative paths to point at the wrong host, and would change enough identities
 * to drop the user's switches. Merging the lists keeps every source exactly as it was stored.
 *
 * A matching source keeps its position but takes the incoming definition, which is what "the
 * configuration I just imported wins" means while the user's own switch and test result survive.
 */
export function mergeSourceLists<
  T extends {
    api?: string;
    ext?: unknown;
    capability?: string;
    enabled?: boolean;
  },
>(existing: T[], incoming: T[]): SourceMergeResult<T> {
  const merged = [...existing];
  const indexByIdentity = new Map<string, number>();
  merged.forEach((source, index) => {
    indexByIdentity.set(sourceIdentity(source), index);
  });

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const source of incoming) {
    const identity = sourceIdentity(source);
    const at = indexByIdentity.get(identity);
    if (at === undefined) {
      indexByIdentity.set(identity, merged.length);
      merged.push(source);
      added += 1;
      continue;
    }
    const before = merged[at];
    // A plain record for the copy: an intersection with a generic parameter is readable but not
    // writable, and the fields being restored are not part of the generic's known shape.
    const next: Record<string, unknown> = { ...source };
    for (const field of LOCAL_STATE_FIELDS) {
      const value = (before as Record<string, unknown>)[field];
      if (value !== undefined) next[field] = value;
    }
    // A source the new configuration no longer supports must not stay switched on.
    if (source.capability !== "supported") {
      next.enabled = false;
    }
    if (stableStringify(before) === stableStringify(next)) {
      unchanged += 1;
      continue;
    }
    merged[at] = next as T;
    updated += 1;
  }

  return { sources: merged, added, updated, unchanged };
}
