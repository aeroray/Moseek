import { lazy, Suspense, useEffect } from "react";

import { AppShell } from "@/components/app-shell";
import { ToastHost } from "@/components/toast-host";
import { ToastProvider } from "@/components/ui/toast";
import {
  isTauriRuntime,
  listConfigDocuments,
  loadActiveConfig,
  recoverKnownLiveSources,
} from "@/lib/tauri";
import { useAppStore } from "@/stores/app-store";
import type { ViewKey } from "@/types/moseek";

const BrowseView = lazy(() =>
  import("@/features/browse/browse-view").then(({ BrowseView }) => ({
    default: BrowseView,
  })),
);
const FavoritesView = lazy(() =>
  import("@/features/browse/favorites-view").then(({ FavoritesView }) => ({
    default: FavoritesView,
  })),
);
const HistoryView = lazy(() =>
  import("@/features/browse/history-view").then(({ HistoryView }) => ({
    default: HistoryView,
  })),
);
const ConfigCenter = lazy(() =>
  import("@/features/config/config-center").then(({ ConfigCenter }) => ({
    default: ConfigCenter,
  })),
);
const LiveView = lazy(() =>
  import("@/features/live/live-view").then(({ LiveView }) => ({
    default: LiveView,
  })),
);
const SettingsView = lazy(() =>
  import("@/features/settings/settings-view").then(({ SettingsView }) => ({
    default: SettingsView,
  })),
);

function App() {
  const activeView = useAppStore((state) => state.activeView);
  const theme = useAppStore((state) => state.theme);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const setTheme = useAppStore((state) => state.setTheme);
  const autoEpgEnabled = useAppStore((state) => state.autoEpgEnabled);
  const setAutoEpgEnabled = useAppStore((state) => state.setAutoEpgEnabled);
  const setConfigDocuments = useAppStore((state) => state.setConfigDocuments);
  const setConfigDocument = useAppStore((state) => state.setConfigDocument);
  const clearConfigDocument = useAppStore((state) => state.clearConfigDocument);
  const history = useAppStore((state) => state.history);
  const favorites = useAppStore((state) => state.favorites);
  const liveFavorites = useAppStore((state) => state.liveFavorites);
  const playbackProgress = useAppStore((state) => state.playbackProgress);
  const clearHistory = useAppStore((state) => state.clearHistory);
  const clearFavorites = useAppStore((state) => state.clearFavorites);

  useEffect(() => {
    const root = document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => {
      root.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && mediaQuery.matches),
      );
    };
    syncTheme();
    if (theme === "system") {
      mediaQuery.addEventListener("change", syncTheme);
      return () => mediaQuery.removeEventListener("change", syncTheme);
    }
  }, [theme]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void Promise.all([listConfigDocuments(), loadActiveConfig()])
      .then(async ([documents, document]) => {
        if (cancelled) return;
        const recoveredDocument = document
          ? await recoverKnownLiveSources(document.id).catch(() => null)
          : null;
        if (cancelled) return;
        const activeDocument = recoveredDocument ?? document;
        setConfigDocuments(documents ?? []);
        if (activeDocument) {
          setConfigDocument(activeDocument);
        } else {
          clearConfigDocument();
        }
      })
      .catch(() => {
        // Keep the persisted frontend snapshot available if the database is temporarily unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [clearConfigDocument, setConfigDocument, setConfigDocuments]);

  const navigate = (view: ViewKey) => {
    setActiveView(view);
  };

  return (
    <ToastProvider>
      <ToastHost>
        <AppShell activeView={activeView} onNavigate={navigate}>
          <Suspense fallback={<ViewLoading />}>
            {activeView === "config" && <ConfigCenter />}
            {activeView === "settings" && (
              <SettingsView
                theme={theme}
                onThemeChange={setTheme}
                autoEpgEnabled={autoEpgEnabled}
                onAutoEpgEnabledChange={setAutoEpgEnabled}
                historyCounts={{
                  vod: history.filter((record) => record.kind === "vod").length,
                  live: history.filter((record) => record.kind === "live").length,
                }}
                favoriteCounts={{
                  vod: favorites.length,
                  live: liveFavorites.length,
                }}
                progressCount={Object.keys(playbackProgress).length}
                onClearHistory={clearHistory}
                onClearFavorites={clearFavorites}
              />
            )}
            {activeView === "browse" && <BrowseView onNavigate={navigate} />}
            {activeView === "live" && <LiveView />}
            {activeView === "favorites" && <FavoritesView onNavigate={navigate} />}
            {activeView === "history" && <HistoryView onNavigate={navigate} />}
          </Suspense>
        </AppShell>
      </ToastHost>
    </ToastProvider>
  );
}

function ViewLoading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      正在加载工作区…
    </div>
  );
}

export default App;
