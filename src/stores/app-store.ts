import { create } from "zustand";
import { persist } from "zustand/middleware";

import { initialSources } from "@/lib/mock-data";
import { setSourceEnabled } from "@/lib/tauri";
import type {
  PlayHistoryRecord,
  SourceRecord,
  ThemeMode,
  ViewKey,
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
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      activeView: "home",
      theme: "system",
      sources: initialSources.map((source) => ({ ...source })),
      rawConfig: "",
      normalizedConfig: "",
      lastImportedAt: null,
      history: [],
      favorites: [],
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
    }),
    {
      name: "moseek-app-state",
      partialize: (state) => ({
        activeView: state.activeView,
        theme: state.theme,
        sources: state.sources,
        rawConfig: state.rawConfig,
        normalizedConfig: state.normalizedConfig,
        lastImportedAt: state.lastImportedAt,
        history: state.history,
        favorites: state.favorites,
      }),
    },
  ),
);
