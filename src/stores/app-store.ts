import { create } from "zustand";

import { initialSources } from "@/lib/mock-data";
import type { SourceRecord, ThemeMode, ViewKey } from "@/types/moseek";

interface AppStore {
  activeView: ViewKey;
  theme: ThemeMode;
  sources: SourceRecord[];
  setActiveView: (view: ViewKey) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleSource: (key: string) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  activeView: "home",
  theme: "system",
  sources: initialSources,
  setActiveView: (activeView) => set({ activeView }),
  setTheme: (theme) => set({ theme }),
  toggleSource: (key) =>
    set((state) => ({
      sources: state.sources.map((source) =>
        source.key === key ? { ...source, enabled: !source.enabled } : source,
      ),
    })),
}));
