import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  removeSources as removeSourcesInConfig,
  setSourceEnabled,
  type ConfigDocumentSummary,
  type StoredConfigDocument,
} from "@/lib/tauri";
import { favoriteKey } from "@/lib/favorite-key";
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

interface AppStore {
  activeView: ViewKey;
  theme: ThemeMode;
  /**
   * Opt-out for the built-in programme guide. On by default because the guide is display-only
   * enrichment and most public lists declare no `epg`; off means only an explicitly configured
   * guide is used, so no third-party guide provider is contacted.
   */
  autoEpgEnabled: boolean;
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
  clearFavorites: () => void;
  toggleFavorite: (item: VodItem) => void;
  setPlaybackProgress: (historyId: string, seconds: number) => void;
  /** Records where the user left off in a favourite, so the page can resume it later. */
  setFavoriteProgress: (itemId: string, progress: FavoriteProgress) => void;
  toggleLiveFavorite: (channel: LiveChannel, sourceName?: string) => void;
  /** Replaces a favourite's snapshot after its episodes were refreshed from a live source. */
  refreshFavorite: (key: string, item: VodItem) => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      activeView: "browse",
      theme: "system",
      autoEpgEnabled: true,
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
          // should not leave entries pointing at nothing.
          favorites: current.favorites.filter(
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
                  // A source the test found broken stops being offered, matching what the
                  // backend persists. Leaving it enabled would keep listing a source we have
                  // just proved does not work.
                  enabled:
                    result.status === "failed" || result.status === "empty"
                      ? false
                      : source.enabled,
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
      clearFavorites: () => set({ favorites: [] }),
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
    }),
    {
      name: "moseek-app-state",
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<AppStore> | undefined;
        const hasImportedConfig = Boolean(persisted?.rawConfig?.trim());
        const hasConfigDocuments = Boolean(persisted?.configDocuments?.length);
        const keepUserContent = hasImportedConfig || hasConfigDocuments;
        const persistedActiveView = (
          persisted as { activeView?: string } | undefined
        )?.activeView;
        return {
          ...currentState,
          ...persisted,
          // Defaults to on for existing installs that predate the setting.
          autoEpgEnabled:
            persisted?.autoEpgEnabled ?? currentState.autoEpgEnabled,
          configDocuments: persisted?.configDocuments ?? [],
          // The cache holds each document's own source list, which carries the same legacy values.
          configDocumentCache: Object.fromEntries(
            Object.entries(persisted?.configDocumentCache ?? {}).map(([id, document]) => [
              id,
              { ...document, sources: migrateSources(document?.sources) },
            ]),
          ),
          activeConfigId: persisted?.activeConfigId ?? null,
          activeView:
            persistedActiveView === "home"
              ? "browse"
              : (persisted?.activeView ?? currentState.activeView),
          sources: keepUserContent ? migrateSources(persisted?.sources) : [],
          history: keepUserContent ? migrateHistory(persisted?.history) : [],
          favorites: keepUserContent
            ? migrateFavorites(persisted?.favorites)
            : [],
          playbackProgress: keepUserContent
            ? (persisted?.playbackProgress ?? {})
            : {},
          liveFavorites: keepUserContent
            ? migrateLiveFavorites(persisted?.liveFavorites)
            : [],
        };
      },
      partialize: (state) => ({
        activeView: state.activeView,
        theme: state.theme,
        autoEpgEnabled: state.autoEpgEnabled,
        configDocuments: state.configDocuments,
        configDocumentCache: state.configDocumentCache,
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
