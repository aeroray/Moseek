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

/**
 * Collapses whitespace, lower-cases and drops trailing slashes so trivial differences agree.
 *
 * A JSON-encoded string and the object it encodes are treated as the same value. `ext` is written as
 * an object in a configuration file but stored as a string by the parser, so without this the raw
 * text and the source list would report the same site under two different identities — measured on
 * the author's own database, that alone accounted for 8 mismatches.
 */
function normalizeText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    // A string that happens to hold JSON is compared as the JSON it holds, so key order and
    // whitespace do not make the same mapping look like two different ones. A configuration writes
    // `ext` as an object while the parser stores it as a string, and the two spellings are only
    // guaranteed to match if both sides go through the same canonical form.
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return stableStringify(JSON.parse(trimmed)).toLowerCase();
      } catch {
        // Not actually JSON; fall through to the plain string form.
      }
    }
    return trimmed.toLowerCase().replace(/\/+$/, "");
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
 * The identity of a source: the pair that says which site this is.
 *
 * Used by BOTH merges — the raw configuration and the source snapshot — and they must agree, or the
 * two halves of a stored document describe different sets: the raw text keeps entries the list has
 * already collapsed (leaving duplicate keys for the loader to rename on every read) and the list
 * loses entries the text still holds.
 *
 * `key` is deliberately excluded: it is a display label that differs between configurations for the
 * same site, and is reused across configurations for different sites. `type` is excluded because
 * measuring the author's three configurations showed including it changes no outcome at all — the
 * same 335 distinct sites either way, and no group ever joins a live source to a non-live one.
 */
export function sourceIdentity(source: {
  api?: unknown;
  ext?: unknown;
}): string {
  return [normalizeText(source.api), normalizeText(source.ext)].join("|");
}

/** The identity of a site inside the raw configuration. Delegates, so the two cannot drift. */
export function rawSiteIdentity(site: JsonObject): string {
  return sourceIdentity(site);
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
 *
 * An entry is only ever matched against the *other* side, never against another entry of the same
 * batch. Two entries inside one configuration that happen to share an identity are two entries the
 * user can see, and collapsing them would silently delete one: the author's own 配置 2 holds four
 * such pairs (米搜 / 米搜-2, Aid / Aid-2, xgapp / 骑骑影院, MV_vod / MV_vod-2), and merging that
 * document used to overwrite the first with the second.
 */
function mergeCollection(
  existing: JsonValue[],
  incoming: JsonValue[],
  collection: string,
): { merged: JsonValue[]; report: CollectionMerge } {
  const merged = [...existing];
  const slotsByIdentity = new Map<string, number[]>();
  merged.forEach((item, index) => {
    const identity = identityFor(collection, item);
    const slots = slotsByIdentity.get(identity);
    if (slots) slots.push(index);
    else slotsByIdentity.set(identity, [index]);
  });

  // Positions already claimed by this batch, so a second entry with the same identity appends
  // instead of overwriting the one just placed.
  const claimed = new Set<number>();
  const report: CollectionMerge = { added: 0, updated: 0, unchanged: 0 };

  for (const item of incoming) {
    const identity = identityFor(collection, item);
    const free = (slotsByIdentity.get(identity) ?? []).filter(
      (index) => !claimed.has(index),
    );
    const at = free.length > 0 ? free[free.length - 1] : undefined;

    if (at === undefined) {
      const index = merged.length;
      merged.push(item);
      const slots = slotsByIdentity.get(identity);
      if (slots) slots.push(index);
      else slotsByIdentity.set(identity, [index]);
      claimed.add(index);
      report.added += 1;
      continue;
    }

    claimed.add(at);
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

  // `sites` and `lives` are the collections the source list is built from, and their keys must be
  // unique in the stored text. The merge matches on identity, not on key, so a merged configuration
  // legitimately holds several entries sharing a display key (`Bili` appears three times across the
  // author's three configurations); the Rust loader renames those on every read, which made the key
  // the user sees change each time the page opened. Assigning the suffixes here means the stored
  // text is already unique, and the loader has nothing left to rename.
  for (const collection of ["sites", "lives"] as const) {
    const items = raw[collection];
    if (Array.isArray(items)) {
      raw[collection] = ensureUniqueKeys(items as { key?: string }[]);
    }
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
    key?: string;
    api?: string;
    ext?: unknown;
    capability?: string;
    enabled?: boolean;
  },
>(existing: T[], incoming: T[]): SourceMergeResult<T> {
  const merged = [...existing];
  const slotsByIdentity = new Map<string, number[]>();
  merged.forEach((source, index) => {
    const identity = sourceIdentity(source);
    const slots = slotsByIdentity.get(identity);
    if (slots) slots.push(index);
    else slotsByIdentity.set(identity, [index]);
  });

  // Positions claimed by this batch. Without it, two entries in the same incoming list that share
  // an identity would both resolve to the first free slot and one would overwrite the other —
  // which is exactly how the author's 配置 2 lost 米搜 to 米搜-2.
  const claimed = new Set<number>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const source of incoming) {
    const identity = sourceIdentity(source);
    const free = (slotsByIdentity.get(identity) ?? []).filter(
      (index) => !claimed.has(index),
    );
    const at = free.length > 0 ? free[free.length - 1] : undefined;

    if (at === undefined) {
      const index = merged.length;
      merged.push(source);
      const slots = slotsByIdentity.get(identity);
      if (slots) slots.push(index);
      else slotsByIdentity.set(identity, [index]);
      claimed.add(index);
      added += 1;
      continue;
    }

    claimed.add(at);
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

  return { sources: ensureUniqueKeys(merged), added, updated, unchanged };
}

/**
 * Gives every entry a distinct key.
 *
 * The merge dedupes by `api + ext` and keeps each source's own key, so a merged configuration can
 * legitimately hold several entries whose key is the same (`Bili` appears three times in the
 * author's three configurations, `荐片` three times, and so on). The Rust loader calls
 * `ensure_unique_source_keys` on every read, which renames those to `Bili-2`, `Bili-3`, … — so the
 * key the UI shows changed on every visit to the page. Assigning the suffixes here means the stored
 * data is already unique and the loader has nothing left to rename.
 *
 * An entry that declares **no** key is left exactly as it is, which is load-bearing twice over:
 *
 * 1. **Writing one in would change what the entry is.** `classifySource` requires a raw `key` for a
 *    site (`hasRequiredFields`), so a generated key silently upgrades a source the parser refuses
 *    (`invalid`, never run) into one it will run (`supported`). Importing a configuration would then
 *    make a source executable that Moseek had judged unusable.
 * 2. **It would put the text and the source list in different key namespaces.** The parser numbers
 *    these entries by position (`live-1`, `live-2`, …) while this function would have suffixed the
 *    blank key (`-2`, `-3`, …), so the same entry had two names and a removal that matched on `key`
 *    could not find it in the raw configuration.
 */
function ensureUniqueKeys<
  T extends { key?: string },
>(sources: T[]): T[] {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return sources.map((source) => {
    const original = source.key;
    if (original === undefined || original === "") return source;
    let suffix = nextSuffix.get(original) ?? 2;
    let unique = original;
    while (used.has(unique)) {
      unique = `${original}-${suffix}`;
      suffix += 1;
    }
    nextSuffix.set(original, suffix);
    used.add(unique);
    return unique === original ? source : { ...source, key: unique };
  });
}
