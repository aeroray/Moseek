import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  removeSources as removeSourcesInConfig,
  setSourceEnabled,
  type ConfigDocumentSummary,
  type StoredConfigDocument,
} from "@/lib/tauri";
import { adapterRegistry } from "@/lib/adapters";
import { favoriteKey } from "@/lib/favorite-key";
import {
  defaultSourceFilter,
  type SourceFilterState,
} from "@/features/config/source-filter";
import {
  pruneCacheToActive,
  rehydrateCache,
  stripCacheForStorage,
} from "@/stores/config-cache-persistence";
import { createAppPersistStorage } from "@/stores/persist-storage";
import type {
  CapabilityStatus,
  FavoriteProgress,
  FootprintKind,
  FootprintRecord,
  LiveChannel,
  LiveFavorite,
  LiveFootprint,
  SourceRecord,
  SourceTestResult,
  ThemeMode,
  ViewKey,
  VodFavorite,
  VodFootprint,
  VodItem,
} from "@/types/moseek";

/**
 * Rewrites a stored source whose capability the current code can no longer produce.
 *
 * "partial" was removed from `CapabilityStatus` because nothing could assign it — no parser branch
 * and no adapter profile. Documents written by an older version still carry it, and rendering those
 * literally is what put 部分支持 on rows that also said 没有可用适配器.
 *
 * The mapping is not a guess: `needs-adapter` was the closest surviving state, and the value only
 * reaches the screen for sources that have no adapter, where the status column is already showing a
 * capability badge rather than a test result. Anything unrecognised folds to `invalid`, which is the
 * honest reading of a record the current model cannot interpret.
 */
function normalizeCapability(value: unknown): CapabilityStatus {
  switch (value) {
    case "supported":
    case "needs-adapter":
    case "blocked":
    case "invalid":
      return value;
    case "partial":
      return "needs-adapter";
    default:
      return "invalid";
  }
}

/**
 * Applies `normalizeCapability` across a stored source list.
 *
 * Exported for its own tests: this runs on data read back from disk, which is the one input that
 * cannot be fixed by changing the code that writes it.
 */
export function migrateSources(sources: SourceRecord[] | undefined): SourceRecord[] {
  if (!Array.isArray(sources)) return [];
  return sources.map((source) => {
    const capability = normalizeCapability(source.capability);
    return capability === source.capability ? source : { ...source, capability };
  });
}

/**
 * Whether a source stays switched on after a test.
 *
 * **Every failure switches the source off, including one that never reached the server.** This
 * mirrors `storage::set_source_test_in_connection`, which is the authority: it persists the decision
 * this function has to agree with, or the list would show one answer until the next reload and
 * another afterwards.
 *
 * It used to exempt transport failures — a timeout, a name that did not resolve, a refused
 * connection — on the theory that they report the network rather than the source. The user's
 * decision is the opposite, and it is the simpler rule: a source we cannot reach is a source we
 * cannot use, so it is 测试失败 like any other and belongs in the same 清理不可用 set. The cost of
 * being wrong is bounded, because the switch is one click away.
 *
 * There is deliberately no branch that switches a source back on. `enabled: false` cannot be told
 * apart from the user having switched the source off themselves, so re-enabling on a pass would
 * silently override an explicit choice.
 */
export function nextEnabledAfterTest(
  source: Pick<SourceRecord, "enabled">,
  result: Pick<SourceTestResult, "status">,
): boolean {
  // `passed` and `blocked` leave the switch where the user put it: the first works, and the second
  // never ran. `failed` and `empty` are both verdicts that it does not work.
  if (result.status === "failed" || result.status === "empty") return false;
  return source.enabled;
}

/**
 * Validates a stored source filter.
 *
 * A persisted shape is input from an older version of the application, so it cannot be trusted: an
 * unrecognised value in a group would match no source and empty the list with no visible cause. Each
 * group is filtered down to the values the current module knows, and anything unusable falls back to
 * the default rather than to "nothing selected" — a filter that silently shows everything is a
 * smaller surprise than one that silently shows nothing.
 */
export function migrateSourceFilter(value: unknown): SourceFilterState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultSourceFilter;
  }
  const stored = value as Partial<Record<keyof SourceFilterState, unknown>>;
  const group = <T extends string>(raw: unknown, allowed: readonly T[]): T[] => {
    if (!Array.isArray(raw)) return [];
    const known = new Set<string>(allowed);
    return raw.filter((item): item is T => typeof item === "string" && known.has(item));
  };
  const migrated: SourceFilterState = {
    adapters: group(
      stored.adapters,
      adapterRegistry.map((profile) => profile.id),
    ),
    executions: group(stored.executions, [
      "enabled",
      "needs-adapter",
      "blocked",
    ] as const),
    // No "blocked": that facet was removed because the 适配器状态 group already offers exactly that
    // set. A filter saved before the change simply loses the choice rather than emptying the list,
    // which is what this validation exists for.
    statuses: group(stored.statuses, [
      "usable",
      "untested",
      "failed",
      "empty",
      "invalid",
    ] as const),
    enabled: group(stored.enabled, ["on", "off"] as const),
  };
  // A shape with nothing usable in it at all is not a filter the user set; it is a value this
  // version cannot read, so the default is restored.
  const recognised =
    Array.isArray(stored.adapters) ||
    Array.isArray(stored.executions) ||
    Array.isArray(stored.statuses) ||
    Array.isArray(stored.enabled);
  return recognised ? migrated : defaultSourceFilter;
}

const sourceToggleQueues = new Map<string, Promise<void>>();

/**
 * Upgrades favourites saved before they carried a snapshot.
 *
 * The old shape was a bare `VodItem[]`, so a stored entry is identifiable by having no `key`.
 * Rather than dropping them — which would silently empty a user's collection on upgrade — each
 * is wrapped with the snapshot it already is. The progress is lost for those entries because the
 * old shape never stored any; that is unavoidable, and it is better than discarding the list.
 */
export function migrateFavorites(persisted: unknown): VodFavorite[] {
  if (!Array.isArray(persisted)) return [];
  const favorites: VodFavorite[] = [];
  for (const entry of persisted) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<VodFavorite> & Partial<VodItem>;
    if (typeof candidate.key === "string" && candidate.item) {
      favorites.push(candidate as VodFavorite);
      continue;
    }
    if (typeof candidate.id === "string" && typeof candidate.name === "string") {
      const item = candidate as VodItem;
      favorites.push({
        key: `${item.sourceKey}:${item.id}`,
        item,
        sourceKey: item.sourceKey,
        sourceName: item.sourceName,
        savedAt: new Date().toISOString(),
        progress: null,
      });
    }
  }
  return favorites;
}

/**
 * Upgrades history saved before footprints carried a `kind`.
 *
 * The old shape was a flat `PlayHistoryRecord`, so an entry is identifiable by having no `kind`
 * and by carrying an `item`. Those are wrapped as VOD footprints, keeping their existing id —
 * `playbackProgress` is keyed by that id, so changing it would silently orphan every saved
 * position.
 */
export function migrateHistory(persisted: unknown): FootprintRecord[] {
  if (!Array.isArray(persisted)) return [];
  const records: FootprintRecord[] = [];
  for (const entry of persisted) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<VodFootprint> & { item?: VodItem };
    if (candidate.kind === "vod" || candidate.kind === "live") {
      records.push(candidate as FootprintRecord);
      continue;
    }
    if (candidate.item) {
      records.push({ ...(candidate as VodFootprint), kind: "vod" });
    }
  }
  return records;
}

/**
 * Upgrades live favourites saved as bare channel-id strings.
 *
 * There is nothing to recover from a string alone, so those entries are dropped rather than
 * turned into a placeholder that would fail when opened. The channel list is one click away and
 * re-favouriting is cheap; a broken entry that looks like a favourite is worse.
 */
export function migrateLiveFavorites(persisted: unknown): LiveFavorite[] {
  if (!Array.isArray(persisted)) return [];
  return persisted.filter(
    (entry): entry is LiveFavorite =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as LiveFavorite).key === "string" &&
      Boolean((entry as LiveFavorite).channel),
  );
}

/**
 * Validates the saved playback positions.
 *
 * This was the one persisted collection that was trusted wholesale, and it is the only one whose
 * values are read as numbers by arithmetic rather than displayed. A stored entry that is not a finite
 * number — a `null` written by an older shape, a string, a `NaN` that survived JSON as `null` — makes
 * the progress bar compute `NaN%` and the resume seek land nowhere, without naming a cause. Dropping
 * the unusable entries keeps every position that is actually a position.
 *
 * Negative and non-finite values are dropped rather than clamped: a negative position is not "almost
 * right", it is a value this app never writes, and treating it as zero would silently restart a work
 * the user had watched.
 */
export function migratePlaybackProgress(
  persisted: unknown,
): Record<string, number> {
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) {
    return {};
  }
  const progress: Record<string, number> = {};
  for (const [id, seconds] of Object.entries(persisted)) {
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
      progress[id] = seconds;
    }
  }
  return progress;
}

/**
 * Validates the stored theme.
 *
 * `theme` was the one persisted preference that flowed through the merge unvalidated, spread in with
 * the rest. It only ever holds three strings, so an unrecognised value means the mirror was written by
 * a different version or edited by hand — and the consequence is silent: `App` toggles the `dark`
 * class for `dark` and `system` only, so anything else renders light for ever while the settings
 * dropdown shows no selection at all. Falling back to `system` is the same choice `sourceFilter` makes
 * for an unknown group: the sensible default rather than a state the user cannot explain.
 */
export function migrateTheme(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

/**
 * The views, as a value rather than a type, so a persisted one can be checked against them.
 *
 * `VIEW_KEYS` mirrors `ViewKey` in `@/types/moseek`. The type cannot be iterated at runtime, and the
 * validation below needs the list — writing it out a second time is the smallest cost of being able to
 * check it at all. A test asserts the two agree, so adding a view without adding it here fails loudly
 * rather than silently rejecting the new key.
 */
export const VIEW_KEYS = [
  "browse",
  "live",
  "favorites",
  "history",
  "config",
  "settings",
] as const;

/**
 * Validates the view the app was left on.
 *
 * **An unrecognised value here renders a blank window.** `App` seeds `visitedViews` with the active
 * view and mounts a pane only for a key it recognises, so a stored `"home"` — the name this view had
 * before the library-first rename — or any value from a future version leaves the workspace empty
 * while the navigation bar still looks functional. Nothing reports it, because nothing went wrong as
 * far as the running code can tell: every condition is simply false.
 *
 * `"home"` is mapped rather than defaulted, because it is the one old name that carried meaning and
 * mapping it preserves where the user actually was.
 */
export function migrateActiveView(value: unknown): ViewKey {
  if (value === "home") return "browse";
  return VIEW_KEYS.includes(value as ViewKey) ? (value as ViewKey) : "browse";
}

interface AppStore {
  activeView: ViewKey;
  theme: ThemeMode;
  /**
   * Opt-out for the built-in programme guide. On by default because the guide is display-only
   * enrichment and most public lists declare no `epg`; off means only an explicitly configured
   * guide is used, so no third-party guide provider is contacted.
   */
  autoEpgEnabled: boolean;
  /**
   * The source list's filter, kept across restarts.
   *
   * It lives in the store rather than in the component's state because it is a preference, not a
   * transient view: a user who narrows the list to the sources they are working on expects to find
   * it that way next time, and re-applying it on every launch is work the application can do for
   * them. Stored as the same shape the filter module uses, so there is no second vocabulary to keep
   * in step.
   */
  sourceFilter: SourceFilterState;
  setSourceFilter: (filter: SourceFilterState) => void;
  /** Whether the filter panel was left expanded. */
  isSourceFilterOpen: boolean;
  setSourceFilterOpen: (open: boolean) => void;
  configDocuments: ConfigDocumentSummary[];
  configDocumentCache: Record<number, StoredConfigDocument>;
  activeConfigId: number | null;
  sources: SourceRecord[];
  rawConfig: string;
  normalizedConfig: string;
  lastImportedAt: string | null;
  history: FootprintRecord[];
  favorites: VodFavorite[];
  playbackProgress: Record<string, number>;
  liveFavorites: LiveFavorite[];
  setActiveView: (view: ViewKey) => void;
  setTheme: (theme: ThemeMode) => void;
  setAutoEpgEnabled: (enabled: boolean) => void;
  removeSources: (keys: string[]) => Promise<void>;
  toggleSource: (key: string) => Promise<void>;
  setSourceTestResult: (key: string, result: SourceTestResult) => void;
  setConfigDocuments: (documents: ConfigDocumentSummary[]) => void;
  setConfigDocument: (document: StoredConfigDocument) => void;
  removeConfigDocument: (documentId: number) => void;
  clearConfigDocument: () => void;
  replaceSources: (sources: SourceRecord[]) => void;
  setConfigSnapshot: (
    rawConfig: string,
    normalizedConfig: string,
    importedAt: string,
  ) => void;
  /** Records a work that was opened. */
  addVodFootprint: (record: Omit<VodFootprint, "kind" | "id" | "updatedAt">) => void;
  /** Records a channel that was watched. */
  addLiveFootprint: (channel: LiveChannel, sourceName: string) => void;
  /**
   * Clears footprints of one kind, or all of them.
   *
   * Clearing everything was the only option, which meant a user who wanted to tidy their film
   * history had to lose their channel history too. The kind is named so each column can offer its
   * own action.
   */
  clearHistory: (kind?: FootprintKind) => void;
  /**
   * Clears favourites of one kind, or all of them.
   *
   * Takes the kind for the same reason `clearHistory` does, and for a second one: the two lists are
   * independent — a work favourite and a channel favourite live in different fields — so a single
   * no-argument clear could only ever remove one of them while appearing to remove both. That is
   * exactly what it did: the settings page offered 清除收藏 with a description promising it removed
   * 影视收藏 and 电视直播收藏, and the implementation dropped only `favorites`.
   */
  clearFavorites: (kind?: FootprintKind) => void;
  toggleFavorite: (item: VodItem) => void;
  setPlaybackProgress: (historyId: string, seconds: number) => void;
  /** Records where the user left off in a favourite, so the page can resume it later. */
  setFavoriteProgress: (itemId: string, progress: FavoriteProgress) => void;
  toggleLiveFavorite: (channel: LiveChannel, sourceName?: string) => void;
  /** Replaces a favourite's snapshot after its episodes were refreshed from a live source. */
  refreshFavorite: (key: string, item: VodItem) => void;
  /**
   * Folds favourites carried by an imported configuration into the current lists.
   *
   * **Merges rather than replaces, and that is the whole design.** An import is a merge everywhere
   * else in this app — sources are folded in, duplicates are skipped — and favourites are the one
   * collection a user cannot reconstruct: replacing them would silently destroy what they had
   * before they pasted a file. Entries already present (same key) are kept as they are, so the
   * local progress on a favourite is not overwritten by the copy that travelled.
   *
   * Returns how many were added, so the caller can say so instead of claiming a silent success.
   */
  restoreFavorites: (incoming: {
    favorites?: VodFavorite[];
    liveFavorites?: LiveFavorite[];
  }) => { vod: number; live: number };
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      activeView: "browse",
      theme: "system",
      autoEpgEnabled: true,
      sourceFilter: defaultSourceFilter,
      isSourceFilterOpen: false,
      configDocuments: [],
      configDocumentCache: {},
      activeConfigId: null,
      sources: [],
      rawConfig: "",
      normalizedConfig: "",
      lastImportedAt: null,
      history: [],
      favorites: [],
      playbackProgress: {},
      liveFavorites: [],
      setActiveView: (activeView) => set({ activeView }),
      setTheme: (theme) => set({ theme }),
      setAutoEpgEnabled: (autoEpgEnabled) => set({ autoEpgEnabled }),
      setSourceFilter: (sourceFilter) => set({ sourceFilter }),
      setSourceFilterOpen: (isSourceFilterOpen) => set({ isSourceFilterOpen }),
      /**
       * Removes sources from the active configuration. The keys are removed from the saved
       * document (both its snapshot and its raw text) and from the in-memory state, so the
       * library stops listing them immediately.
       */
      removeSources: async (keys) => {
        const state = get();
        if (state.activeConfigId === null || keys.length === 0) return;
        const removing = new Set(keys);
        const document = await removeSourcesInConfig(state.activeConfigId, keys);
        if (!document) throw new Error("浏览器预览不会删除源。");
        set((current) => ({
          sources: current.sources.filter(
            (source) => !removing.has(source.key),
          ),
          // Favourites and history are keyed by source too; a source that no longer exists
          // should not leave entries pointing at nothing. `liveFavorites` is a separate list —
          // works and channels are stored apart — so it needs its own filter: without it a
          // removed live source left its channel favourites behind, and the confirmation says
          // "相关收藏和播放记录会一并清理".
          favorites: current.favorites.filter(
            (favorite) => !removing.has(favorite.sourceKey),
          ),
          liveFavorites: current.liveFavorites.filter(
            (favorite) => !removing.has(favorite.sourceKey),
          ),
          history: current.history.filter((record) =>
            record.kind === "vod"
              ? !removing.has(record.item.sourceKey)
              : !removing.has(record.channel.sourceKey),
          ),
        }));
        get().setConfigDocument(document);
      },
      toggleSource: async (key) => {
        const initialState = get();
        if (initialState.activeConfigId === null) return;
        const queueKey = `${initialState.activeConfigId}:${key}`;
        const previous = sourceToggleQueues.get(queueKey) ?? Promise.resolve();
        const operation = previous
          .catch(() => undefined)
          .then(async () => {
            const currentState = get();
            const activeConfigId = currentState.activeConfigId;
            const currentSource = currentState.sources.find(
              (source) => source.key === key,
            );
            if (activeConfigId === null || !currentSource) return;
            const previousEnabled = currentSource.enabled;
            const nextEnabled = !previousEnabled;
            set((state) => ({
              sources: state.sources.map((source) =>
                source.key === key
                  ? { ...source, enabled: nextEnabled }
                  : source,
              ),
              normalizedConfig: updateNormalizedConfigEnabled(
                state.normalizedConfig,
                key,
                nextEnabled,
              ),
            }));
            try {
              const document = await setSourceEnabled(
                activeConfigId,
                key,
                nextEnabled,
              );
              if (document && get().activeConfigId === activeConfigId) {
                get().setConfigDocument(document);
              }
            } catch (error) {
              if (get().activeConfigId === activeConfigId) {
                set((state) => ({
                  sources: state.sources.map((source) =>
                    source.key === key
                      ? { ...source, enabled: previousEnabled }
                      : source,
                  ),
                  normalizedConfig: updateNormalizedConfigEnabled(
                    state.normalizedConfig,
                    key,
                    previousEnabled,
                  ),
                }));
              }
              throw error;
            }
          });
        sourceToggleQueues.set(queueKey, operation);
        try {
          await operation;
        } finally {
          if (sourceToggleQueues.get(queueKey) === operation) {
            sourceToggleQueues.delete(queueKey);
          }
        }
      },
      setSourceTestResult: (key, result) =>
        set((state) => ({
          sources: state.sources.map((source) =>
            source.key === key
              ? {
                  ...source,
                  testStatus: result.status,
                  testMessage: result.message,
                  testedAt: result.testedAt,
                  testItemCount: result.itemCount,
                  testCategoryCount: result.categoryCount,
                  testDurationMs: result.durationMs,
                  testOperations: result.operations,
                  lastCheckedAt: result.testedAt,
                  // Matches what the backend persists. Only an answer the server actually gave can
                  // switch a source off: a transport failure reports the network, not the source,
                  // and disabling on one of those discards a source for a reason that may not exist
                  // a minute later. A pass switches it back on, so the rule is not a one-way door.
                  enabled: nextEnabledAfterTest(source, result),
                  requestCount:
                    source.requestCount + (result.status === "blocked" ? 0 : 1),
                }
              : source,
          ),
        })),
      setConfigDocuments: (configDocuments) => set({ configDocuments }),
      setConfigDocument: (document) =>
        set((state) => ({
          activeConfigId: document.id,
          configDocumentCache: {
            ...state.configDocumentCache,
            [document.id]: document,
          },
          sources: document.sources.map((source) => ({ ...source })),
          rawConfig: document.rawConfig,
          normalizedConfig: document.normalizedConfig,
          lastImportedAt: document.importedAt,
          configDocuments: [
            {
              id: document.id,
              name: document.name,
              sourceCount: document.sourceCount,
              liveCount: document.liveCount,
              importedAt: document.importedAt,
            },
            ...state.configDocuments.filter((item) => item.id !== document.id),
          ],
        })),
      removeConfigDocument: (documentId) =>
        set((state) => {
          const configDocumentCache = { ...state.configDocumentCache };
          delete configDocumentCache[documentId];
          return {
            configDocuments: state.configDocuments.filter(
              (document) => document.id !== documentId,
            ),
            configDocumentCache,
            ...(state.activeConfigId === documentId
              ? {
                  activeConfigId: null,
                  sources: [],
                  rawConfig: "",
                  normalizedConfig: "",
                  lastImportedAt: null,
                }
              : {}),
          };
        }),
      clearConfigDocument: () =>
        set({
          activeConfigId: null,
          sources: [],
          rawConfig: "",
          normalizedConfig: "",
          lastImportedAt: null,
        }),
      replaceSources: (sources) =>
        set({ sources: sources.map((source) => ({ ...source })) }),
      setConfigSnapshot: (rawConfig, normalizedConfig, lastImportedAt) =>
        set({ rawConfig, normalizedConfig, lastImportedAt }),
      /**
       * Records that a work was opened.
       *
       * Called on entry, not only when an episode is picked: the previous version recorded
       * nothing until the user actively switched episodes, so simply opening a film and watching
       * it left no trace at all — which is why the page was always empty.
       *
       * Re-opening the same episode moves it to the top rather than adding a duplicate, so the
       * list reads as "where I have been", most recent first, not as an append-only log.
       */
      addVodFootprint: (record) =>
        set((state) => {
          const footprint: VodFootprint = {
            ...record,
            kind: "vod",
            // Deliberately the same key `playbackProgress` uses. The progress map updates the
            // matching history record by id, so prefixing this would leave every saved position
            // pointing at a record that no longer exists.
            id: `${record.item.id}:${record.episodeId}`,
            updatedAt: new Date().toISOString(),
          };
          return {
            history: [
              footprint,
              ...state.history.filter((item) => item.id !== footprint.id),
            ].slice(0, 200),
          };
        }),
      addLiveFootprint: (channel, sourceName) =>
        set((state) => {
          const footprint: LiveFootprint = {
            kind: "live",
            id: `live:${channel.id}`,
            channel,
            sourceName,
            updatedAt: new Date().toISOString(),
          };
          return {
            history: [
              footprint,
              ...state.history.filter((item) => item.id !== footprint.id),
            ].slice(0, 200),
          };
        }),
      // Playback progress is keyed by history id and has no meaning without the record it belongs
      // to, so clearing history drops the progress of exactly the records that went. Favourites are
      // a separate list and are deliberately left alone.
      clearHistory: (kind) =>
        set((state) => {
          if (kind === undefined) return { history: [], playbackProgress: {} };
          const removing = new Set(
            state.history
              .filter((record) => record.kind === kind)
              .map((record) => record.id),
          );
          const playbackProgress = Object.fromEntries(
            Object.entries(state.playbackProgress).filter(
              ([id]) => !removing.has(id),
            ),
          );
          return {
            history: state.history.filter((record) => record.kind !== kind),
            playbackProgress,
          };
        }),
      clearFavorites: (kind) =>
        // One field per kind, so a partial clear leaves the other list untouched rather than
        // rebuilding it from the same source and risking a silent drop.
        kind === undefined
          ? set({ favorites: [], liveFavorites: [] })
          : kind === "vod"
            ? set({ favorites: [] })
            : set({ liveFavorites: [] }),
      /**
       * Adds or removes a favourite, storing the item whole.
       *
       * The snapshot is deliberate: a favourite has to survive its source being renamed,
       * reordered or deleted, and it has to be playable the instant it is opened. Keeping only a
       * key would make the favourites page depend on a source that may no longer exist.
       *
       * Re-favouriting keeps the existing progress. Losing your place because you toggled the
       * heart off and back on would be a surprising way to lose it.
       */
      toggleFavorite: (item) =>
        set((state) => {
          const key = favoriteKey(item);
          const existing = state.favorites.find(
            (favorite) => favorite.key === key,
          );
          if (existing) {
            return {
              favorites: state.favorites.filter(
                (favorite) => favorite.key !== key,
              ),
            };
          }
          return {
            favorites: [
              {
                key,
                item,
                sourceKey: item.sourceKey,
                sourceName: item.sourceName,
                savedAt: new Date().toISOString(),
                progress: null,
              },
              ...state.favorites,
            ],
          };
        }),
      setFavoriteProgress: (itemId, progress) =>
        set((state) => ({
          favorites: state.favorites.map((favorite) =>
            favorite.item.id === itemId
              ? { ...favorite, progress }
              : favorite,
          ),
        })),
      refreshFavorite: (key, item) =>
        set((state) => ({
          favorites: state.favorites.map((favorite) =>
            favorite.key === key ? { ...favorite, item } : favorite,
          ),
        })),
      setPlaybackProgress: (historyId, seconds) =>
        set((state) => {
          const progress = Math.max(0, Math.floor(seconds));
          return {
            playbackProgress: {
              ...state.playbackProgress,
              [historyId]: progress,
            },
            history: state.history.map((record) =>
              // Only a work has a position to update; a channel is live and has none.
              record.id === historyId && record.kind === "vod"
                ? { ...record, progress }
                : record,
            ),
          };
        }),
      toggleLiveFavorite: (channel, sourceName) =>
        set((state) => {
          const exists = state.liveFavorites.some(
            (favorite) => favorite.key === channel.id,
          );
          if (exists) {
            return {
              liveFavorites: state.liveFavorites.filter(
                (favorite) => favorite.key !== channel.id,
              ),
            };
          }
          // The channel is stored whole, with every stream URL it had. Its source may be
          // deleted tomorrow; the channel still has to play.
          return {
            liveFavorites: [
              {
                key: channel.id,
                channel,
                sourceKey: channel.sourceKey,
                sourceName: sourceName ?? channel.sourceKey,
                savedAt: new Date().toISOString(),
              },
              ...state.liveFavorites,
            ],
          };
        }),
      restoreFavorites: (incoming) => {
        let addedVod = 0;
        let addedLive = 0;
        set((state) => {
          // Existing keys win, so a favourite's local progress survives the import.
          const vodKeys = new Set(state.favorites.map((favorite) => favorite.key));
          const liveKeys = new Set(
            state.liveFavorites.map((favorite) => favorite.key),
          );
          const incomingVod = (incoming.favorites ?? []).filter(
            (favorite) => !vodKeys.has(favorite.key),
          );
          const incomingLive = (incoming.liveFavorites ?? []).filter(
            (favorite) => !liveKeys.has(favorite.key),
          );
          addedVod = incomingVod.length;
          addedLive = incomingLive.length;
          if (addedVod === 0 && addedLive === 0) return {};
          return {
            // Appended rather than prepended: the list is ordered newest-first, and an imported
            // favourite was not saved now. Claiming otherwise would reorder a user's collection to
            // put a file's contents on top.
            favorites: [...state.favorites, ...incomingVod],
            liveFavorites: [...state.liveFavorites, ...incomingLive],
          };
        });
        return { vod: addedVod, live: addedLive };
      },
    }),
    {
      name: "moseek-app-state",
      // A full localStorage degrades the mirror instead of failing the operation that wrote it.
      // See `persist-storage.ts`: the exception used to escape through `setState` and surface as
      // "解析成功，但保存失败 ... exceeded the quota" under the title "需要修正配置", which named
      // neither the real cause nor the fact that the configuration had been saved.
      storage: createAppPersistStorage(),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<AppStore> | undefined;
        /**
         * Whether the mirror's configuration looks like a real import.
         *
         * **This gates only the fields SQLite owns**, and keeping that distinction is the whole point
         * of the two constants below. `sources`, `rawConfig` and `normalizedConfig` are a *mirror* of
         * the database: `App` reloads them from the backend on every launch, so a persisted copy that
         * does not describe an actual import is stale and dropping it is correct — the backend is
         * about to supply the truth.
         *
         * It used to gate the collections as well, which was a data-loss bug: `favorites`, `history`,
         * `liveFavorites` and `playbackProgress` live **only** here. Measured — the Rust tables
         * `favorites` and `play_history` exist but are never read or written by any command, so
         * localStorage is their single home. Gating them on an imported configuration meant an install
         * with no configuration (a fresh one, or one whose import was cleared) silently discarded the
         * user's collection on the next launch, with nothing to restore it from.
         *
         * `persist-storage.ts` states the same rule from the other side: when a full localStorage
         * forces the mirror to shrink, the document payload is what it drops, because those are the
         * three fields SQLite can supply again — "the small fields that have no other home (theme,
         * view, filter, favourites, footprint) are kept".
         */
        const hasImportedConfig =
          typeof persisted?.rawConfig === "string" &&
          Boolean(persisted.rawConfig.trim());
        const hasConfigDocuments = Array.isArray(persisted?.configDocuments)
          ? persisted.configDocuments.length > 0
          : false;
        const keepMirroredDocument = hasImportedConfig || hasConfigDocuments;
        return {
          ...currentState,
          ...persisted,
          // Validated like the others rather than trusted from the spread above. See `migrateTheme`.

          // Defaults to on for existing installs that predate the setting.
          autoEpgEnabled:
            persisted?.autoEpgEnabled ?? currentState.autoEpgEnabled,
          // The stored filter is validated rather than trusted: it is a persisted shape that a
          // newer version could have widened, and a value the filter module does not know would
          // silently exclude every source. An unrecognised group folds back to the default instead.
          theme: migrateTheme(persisted?.theme),
          sourceFilter: migrateSourceFilter(persisted?.sourceFilter),
          isSourceFilterOpen: persisted?.isSourceFilterOpen ?? false,
          // Shape-checked rather than defaulted: `?? []` only replaces `null`/`undefined`, so a
          // non-array from an older or hand-edited mirror would reach the UI, where every reader maps
          // over it. `configDocuments` is also the other half of the gate above, so a non-array there
          // has to answer "no documents" rather than a truthy object.
          configDocuments: Array.isArray(persisted?.configDocuments)
            ? persisted.configDocuments
            : [],
          // The cache is stored stripped, so the active document's payload is put back from the top
          // level — which is where it lives and what it describes. See
          // `src/stores/config-cache-persistence.ts` for why it is stored that way.
          configDocumentCache: rehydrateCache(
            (persisted as { configDocumentCache?: Record<number, never> } | undefined)
              ?.configDocumentCache,
            {
              activeConfigId: persisted?.activeConfigId ?? null,
              rawConfig: persisted?.rawConfig ?? "",
              normalizedConfig: persisted?.normalizedConfig ?? "",
              sources: migrateSources(persisted?.sources),
            },
          ),
          activeConfigId: persisted?.activeConfigId ?? null,
          activeView: migrateActiveView(persisted?.activeView),
          // The mirror. Safe to drop when it does not describe an import, because the backend
          // reloads these on startup.
          sources: keepMirroredDocument ? migrateSources(persisted?.sources) : [],
          // The user's own content, kept unconditionally. The migrations above are what validate the
          // stored shape — each returns `[]` for anything that is not the array it expects — so a
          // second, coarser check here would only ever remove data that the migration had already
          // vouched for.
          history: migrateHistory(persisted?.history),
          favorites: migrateFavorites(persisted?.favorites),
          playbackProgress: migratePlaybackProgress(persisted?.playbackProgress),
          liveFavorites: migrateLiveFavorites(persisted?.liveFavorites),
        };
      },
      partialize: (state) => ({
        activeView: state.activeView,
        theme: state.theme,
        autoEpgEnabled: state.autoEpgEnabled,
        sourceFilter: state.sourceFilter,
        isSourceFilterOpen: state.isSourceFilterOpen,
        configDocuments: state.configDocuments,
        // Stripped and pruned. The cache used to persist each document's text and source list as well,
        // which duplicated what the top level already holds and — because every save produces a new
        // document id while the cache only ever added — grew by a full copy per save. Measured at
        // 2233 KB an entry against a 5120 KB quota, that is what raised the storage-quota error.
        configDocumentCache: pruneCacheToActive(
          stripCacheForStorage(state.configDocumentCache),
          state.activeConfigId,
        ),
        activeConfigId: state.activeConfigId,
        sources: state.sources,
        rawConfig: state.rawConfig,
        normalizedConfig: state.normalizedConfig,
        lastImportedAt: state.lastImportedAt,
        history: state.history,
        favorites: state.favorites,
        playbackProgress: state.playbackProgress,
        liveFavorites: state.liveFavorites,
      }),
    },
  ),
);

function updateNormalizedConfigEnabled(
  normalizedConfig: string,
  sourceKey: string,
  enabled: boolean,
) {
  if (!normalizedConfig.trim()) return normalizedConfig;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedConfig);
  } catch {
    return normalizedConfig;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return normalizedConfig;
  }
  const config = parsed as Record<string, unknown>;
  for (const section of ["sites", "lives"]) {
    const items = config[section];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const source = item as Record<string, unknown>;
      if (source.key === sourceKey) source.enabled = enabled;
    }
  }
  return JSON.stringify(parsed, null, 2);
}
