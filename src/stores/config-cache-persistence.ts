import type { StoredConfigDocument } from "@/lib/tauri";
import type { SourceRecord } from "@/types/moseek";

/**
 * What a cache entry looks like once the duplicated payload is taken out of it.
 *
 * The cache exists so `activeDocument` can answer questions about the open configuration — its name,
 * its base URL, its live count. It does NOT need to carry the document's own copy of the text and the
 * source list, because those are already stored at the top level of the same persisted object, and
 * the active document is by definition the one those describe.
 */
export type PersistedCacheEntry = Omit<
  StoredConfigDocument,
  "rawConfig" | "normalizedConfig" | "sources"
>;

/**
 * Strips the duplicated payload from every cache entry, keeping only what the top level does not
 * already hold.
 *
 * **Measured, and this is what the quota error was.** A cache entry is ~2233 KB on the owner's
 * configuration (302 KB of text, 718 KB of normalised text, 1213 KB of sources), and the whole
 * persisted object was 4467 KB against a 5120 KB localStorage quota — 87%, with the cache alone
 * accounting for half.
 *
 * Worse, the cache GREW. `replace_all_config_documents` deletes every row and inserts one, so each
 * save produces a new document id, and `setConfigDocument` adds an entry keyed by that id without
 * removing the previous one. Auto-save means that happens on every edit, so a second entry — another
 * 2233 KB — was only ever a few saves away, and it is what pushed the payload past the quota.
 *
 * So this does two things at once: it removes the duplication (one copy instead of two) and it stops
 * the growth from being able to matter, because a stripped entry is a few hundred bytes.
 */
export function stripCacheForStorage(
  cache: Record<number, StoredConfigDocument>,
): Record<number, PersistedCacheEntry> {
  const stripped: Record<number, PersistedCacheEntry> = {};
  for (const [id, document] of Object.entries(cache)) {
    if (!document) continue;
    const { rawConfig, normalizedConfig, sources, ...rest } = document;
    // Referenced so the destructuring is visibly deliberate rather than a lint appeasement: these are
    // the three fields being dropped, and the point is that they are the big ones.
    void rawConfig;
    void normalizedConfig;
    void sources;
    stripped[Number(id)] = rest;
  }
  return stripped;
}

/**
 * Puts the active document's payload back after a reload.
 *
 * Only the ACTIVE document can be rebuilt, because the top level holds exactly one document's text
 * and sources. That is the correct scope rather than a limitation: the app keeps a single 中心配置,
 * and an older database's extra documents are collapsed on load anyway. A non-active entry is
 * restored with empty payload, which is honest — we no longer have it — and it is never read, because
 * every reader goes through `activeConfigId`.
 */
export function rehydrateCache(
  stripped: Record<number, PersistedCacheEntry> | undefined,
  active: {
    activeConfigId: number | null;
    rawConfig: string;
    normalizedConfig: string;
    sources: SourceRecord[];
  },
): Record<number, StoredConfigDocument> {
  const cache: Record<number, StoredConfigDocument> = {};
  for (const [id, entry] of Object.entries(stripped && typeof stripped === "object" && !Array.isArray(stripped) ? stripped : {})) {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const isActive = numericId === active.activeConfigId;
    cache[numericId] = {
      id: numericId,
      name: typeof entry.name === "string" ? entry.name : "中心配置",
      sourceCount: typeof entry.sourceCount === "number" ? entry.sourceCount : active.sources.length,
      liveCount: typeof entry.liveCount === "number" ? entry.liveCount : 0,
      importedAt: typeof entry.importedAt === "string" ? entry.importedAt : new Date(0).toISOString(),
      sourceBaseUrl: typeof entry.sourceBaseUrl === "string" ? entry.sourceBaseUrl : null,
      rawConfig: isActive ? active.rawConfig : "",
      normalizedConfig: isActive ? active.normalizedConfig : "",
      sources: isActive ? active.sources : [],
    };
  }

  // A payload with an active id but no cache entry — a database written before the cache existed, or
  // one whose entry was pruned — still needs an `activeDocument`, or the page loses the base URL and
  // the name. Rebuilding it from the top level is what keeps that from being a blank page.
  if (active.activeConfigId !== null && !cache[active.activeConfigId]) {
    cache[active.activeConfigId] = {
      id: active.activeConfigId,
      name: "中心配置",
      rawConfig: active.rawConfig,
      normalizedConfig: active.normalizedConfig,
      sources: active.sources,
      sourceCount: active.sources.length,
      liveCount: active.sources.filter((source) => source.sourceType === "live").length,
      importedAt: new Date(0).toISOString(),
      sourceBaseUrl: null,
    };
  }

  return cache;
}

/**
 * Keeps only the newest cache entry.
 *
 * Belt and braces beside `stripCacheForStorage`. Even stripped, an entry per save is unbounded growth
 * for no benefit — only the active document is ever read — so the cache is pruned to it on the way
 * into storage. A `Record` with one key also cannot be mistaken for a document history.
 */
export function pruneCacheToActive(
  cache: Record<number, PersistedCacheEntry>,
  activeConfigId: number | null,
): Record<number, PersistedCacheEntry> {
  if (activeConfigId === null) return {};
  const entry = cache[activeConfigId];
  return entry ? { [activeConfigId]: entry } : {};
}
