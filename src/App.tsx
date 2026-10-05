import { lazy, Suspense, useEffect, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { ToastHost } from "@/components/toast-host";
import { ToastProvider } from "@/components/ui/toast";
import { ViewPane } from "@/components/view-pane";
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

  /**
   * The views that have been opened at least once.
   *
   * The first visit mounts a view and loads normally — that is the expected behaviour, and eagerly
   * mounting all six would fire every view's initial requests at launch. Once visited, a view stays
   * mounted (hidden) so returning to it keeps its search, its page, its selection and its scroll
   * position. This is the in-session rule only: closing the app discards all of it, which is what
   * the user asked for.
   *
   * Seeded with the active view so the first render mounts something even if it is not "browse" —
   * the store persists `activeView`, so a user who left the app in 电视直播 reopens there.
   */
  const [visitedViews, setVisitedViews] = useState<ViewKey[]>(() => [activeView]);
  useEffect(() => {
    setVisitedViews((current) =>
      current.includes(activeView) ? current : [...current, activeView],
    );
  }, [activeView]);

  return (
    <ToastProvider>
      <ToastHost>
        <AppShell activeView={activeView} onNavigate={navigate}>
          <Suspense fallback={<ViewLoading />}>
            {/* The workspace is `relative` so each pane can fill it without the panes stacking in
                normal flow; `ViewPane` carries the reasoning for keeping them mounted at all. */}
            <div className="relative h-full w-full">
              {visitedViews.includes("browse") && (
                <ViewPane active={activeView === "browse"}>
                  <BrowseView onNavigate={navigate} />
                </ViewPane>
              )}
              {visitedViews.includes("live") && (
                <ViewPane active={activeView === "live"}>
                  <LiveView />
                </ViewPane>
              )}
              {visitedViews.includes("favorites") && (
                <ViewPane active={activeView === "favorites"}>
                  <FavoritesView onNavigate={navigate} />
                </ViewPane>
              )}
              {visitedViews.includes("history") && (
                <ViewPane active={activeView === "history"}>
                  <HistoryView onNavigate={navigate} />
                </ViewPane>
              )}
              {visitedViews.includes("config") && (
                <ViewPane active={activeView === "config"}>
                  <ConfigCenter />
                </ViewPane>
              )}
              {visitedViews.includes("settings") && (
                <ViewPane active={activeView === "settings"}>
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
                </ViewPane>
              )}
            </div>
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
