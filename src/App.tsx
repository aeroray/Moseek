import { useEffect } from "react";

import { AppShell } from "@/components/app-shell";
import { BrowseView } from "@/features/browse/browse-view";
import { FavoritesView } from "@/features/browse/favorites-view";
import { HistoryView } from "@/features/browse/history-view";
import { ConfigCenter } from "@/features/config/config-center";
import { LiveView } from "@/features/live/live-view";
import { SettingsView } from "@/features/settings/settings-view";
import {
  isTauriRuntime,
  listConfigDocuments,
  loadActiveConfig,
} from "@/lib/tauri";
import { useAppStore } from "@/stores/app-store";
import type { ViewKey } from "@/types/moseek";

function App() {
  const activeView = useAppStore((state) => state.activeView);
  const theme = useAppStore((state) => state.theme);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const setTheme = useAppStore((state) => state.setTheme);
  const setConfigDocuments = useAppStore((state) => state.setConfigDocuments);
  const setConfigDocument = useAppStore((state) => state.setConfigDocument);
  const clearConfigDocument = useAppStore((state) => state.clearConfigDocument);

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
      .then(([documents, document]) => {
        if (cancelled) return;
        setConfigDocuments(documents ?? []);
        if (document) {
          setConfigDocument(document);
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
    <AppShell activeView={activeView} onNavigate={navigate}>
      {activeView === "config" && <ConfigCenter />}
      {activeView === "settings" && (
        <SettingsView theme={theme} onThemeChange={setTheme} />
      )}
      {activeView === "browse" && <BrowseView onNavigate={navigate} />}
      {activeView === "live" && <LiveView />}
      {activeView === "favorites" && <FavoritesView onNavigate={navigate} />}
      {activeView === "history" && <HistoryView onNavigate={navigate} />}
    </AppShell>
  );
}

export default App;
