import { useEffect } from "react";

import { AppShell } from "@/components/app-shell";
import { BrowseView } from "@/features/browse/browse-view";
import { FavoritesView } from "@/features/browse/favorites-view";
import { HistoryView } from "@/features/browse/history-view";
import { ConfigCenter } from "@/features/config/config-center";
import { LiveView } from "@/features/live/live-view";
import { SettingsView } from "@/features/settings/settings-view";
import { useAppStore } from "@/stores/app-store";
import type { ViewKey } from "@/types/moseek";

function App() {
  const activeView = useAppStore((state) => state.activeView);
  const theme = useAppStore((state) => state.theme);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const setTheme = useAppStore((state) => state.setTheme);

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
