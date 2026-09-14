import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  setSourceEnabled,
  type ConfigDocumentSummary,
  type StoredConfigDocument,
} from "@/lib/tauri";
import type {
  PlayHistoryRecord,
  SourceRecord,
  SourceTestResult,
  ThemeMode,
  ViewKey,
  LiveChannel,
  VodItem,
} from "@/types/moseek";

interface AppStore {
  activeView: ViewKey;
  theme: ThemeMode;
  configDocuments: ConfigDocumentSummary[];
  configDocumentCache: Record<number, StoredConfigDocument>;
  activeConfigId: number | null;
  sources: SourceRecord[];
  rawConfig: string;
  normalizedConfig: string;
  lastImportedAt: string | null;
  history: PlayHistoryRecord[];
  favorites: VodItem[];
  playbackProgress: Record<string, number>;
  liveFavorites: string[];
  setActiveView: (view: ViewKey) => void;
  setTheme: (theme: ThemeMode) => void;
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
  addHistory: (record: Omit<PlayHistoryRecord, "id" | "updatedAt">) => void;
  clearHistory: () => void;
  toggleFavorite: (item: VodItem) => void;
  setPlaybackProgress: (historyId: string, seconds: number) => void;
  toggleLiveFavorite: (channel: LiveChannel) => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      activeView: "browse",
      theme: "system",
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
      toggleSource: async (key) => {
        const currentState = get();
        const currentSource = currentState.sources.find(
          (source) => source.key === key,
        );
        if (!currentSource) return;
        const nextEnabled = !currentSource.enabled;
        set((state) => ({
          sources: state.sources.map((source) =>
            source.key === key ? { ...source, enabled: nextEnabled } : source,
          ),
          normalizedConfig: updateNormalizedConfigEnabled(
            state.normalizedConfig,
            key,
            nextEnabled,
          ),
        }));
        if (currentState.activeConfigId === null) return;
        try {
          const document = await setSourceEnabled(
            currentState.activeConfigId,
            key,
            nextEnabled,
          );
          if (document) get().setConfigDocument(document);
        } catch (error) {
          set((state) => ({
            sources: state.sources.map((source) =>
              source.key === key
                ? { ...source, enabled: currentSource.enabled }
                : source,
            ),
            normalizedConfig: updateNormalizedConfigEnabled(
              state.normalizedConfig,
              key,
              currentSource.enabled,
            ),
          }));
          throw error;
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
                  lastCheckedAt: result.testedAt,
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
          const { [documentId]: _removed, ...configDocumentCache } =
            state.configDocumentCache;
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
      addHistory: (record) =>
        set((state) => {
          const historyRecord: PlayHistoryRecord = {
            ...record,
            id: `${record.item.id}:${record.episodeId}`,
            updatedAt: new Date().toISOString(),
          };
          return {
            history: [
              historyRecord,
              ...state.history.filter((item) => item.id !== historyRecord.id),
            ].slice(0, 100),
          };
        }),
      clearHistory: () => set({ history: [] }),
      toggleFavorite: (item) =>
        set((state) => {
          const isFavorite = state.favorites.some(
            (favorite) => favorite.id === item.id,
          );
          return {
            favorites: isFavorite
              ? state.favorites.filter((favorite) => favorite.id !== item.id)
              : [item, ...state.favorites],
          };
        }),
      setPlaybackProgress: (historyId, seconds) =>
        set((state) => {
          const progress = Math.max(0, Math.floor(seconds));
          return {
            playbackProgress: {
              ...state.playbackProgress,
              [historyId]: progress,
            },
            history: state.history.map((record) =>
              record.id === historyId ? { ...record, progress } : record,
            ),
          };
        }),
      toggleLiveFavorite: (channel) =>
        set((state) => ({
          liveFavorites: state.liveFavorites.includes(channel.id)
            ? state.liveFavorites.filter((id) => id !== channel.id)
            : [channel.id, ...state.liveFavorites],
        })),
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
          configDocuments: persisted?.configDocuments ?? [],
          configDocumentCache: persisted?.configDocumentCache ?? {},
          activeConfigId: persisted?.activeConfigId ?? null,
          activeView:
            persistedActiveView === "home"
              ? "browse"
              : (persisted?.activeView ?? currentState.activeView),
          sources: keepUserContent ? (persisted?.sources ?? []) : [],
          history: keepUserContent ? (persisted?.history ?? []) : [],
          favorites: keepUserContent ? (persisted?.favorites ?? []) : [],
          playbackProgress: keepUserContent
            ? (persisted?.playbackProgress ?? {})
            : {},
          liveFavorites: keepUserContent
            ? (persisted?.liveFavorites ?? [])
            : [],
        };
      },
      partialize: (state) => ({
        activeView: state.activeView,
        theme: state.theme,
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
