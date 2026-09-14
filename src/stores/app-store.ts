import { create } from "zustand";
import { persist } from "zustand/middleware";

import { setSourceEnabled } from "@/lib/tauri";
import type {
  PlayHistoryRecord,
  SourceRecord,
  ThemeMode,
  ViewKey,
  LiveChannel,
  VodItem,
} from "@/types/moseek";

interface AppStore {
  activeView: ViewKey;
  theme: ThemeMode;
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
  toggleSource: (key: string) => void;
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
    (set) => ({
      activeView: "browse",
      theme: "system",
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
      toggleSource: (key) => {
        let nextEnabled: boolean | undefined;
        set((state) => ({
          sources: state.sources.map((source) => {
            if (source.key !== key) return source;
            nextEnabled = !source.enabled;
            return { ...source, enabled: nextEnabled };
          }),
        }));
        if (nextEnabled !== undefined) {
          void setSourceEnabled(key, nextEnabled);
        }
      },
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
        const hasSources = Boolean(persisted?.sources?.length);
        const keepUserContent = hasImportedConfig && hasSources;
        const persistedActiveView = (
          persisted as { activeView?: string } | undefined
        )?.activeView;
        return {
          ...currentState,
          ...persisted,
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
