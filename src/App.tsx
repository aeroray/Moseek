import { useEffect, useState } from "react";
import {
  Clapperboard,
  FileSliders,
  History,
  Library,
  Radio,
  Search,
  Settings2,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BrowseView } from "@/features/browse/browse-view";
import { FavoritesView } from "@/features/browse/favorites-view";
import { HistoryView } from "@/features/browse/history-view";
import { ConfigCenter } from "@/features/config/config-center";
import { HomeView } from "@/features/overview/home-view";
import { PlaceholderView } from "@/features/placeholder-view";
import { SettingsView } from "@/features/settings/settings-view";
import { useAppStore } from "@/stores/app-store";
import type { ViewKey } from "@/types/moseek";

const commandItems: {
  key: ViewKey;
  label: string;
  description: string;
  icon: typeof Library;
}[] = [
  {
    key: "home",
    label: "打开总览",
    description: "查看工作区健康状态",
    icon: Library,
  },
  {
    key: "browse",
    label: "打开影视库",
    description: "搜索与浏览影视资源",
    icon: Library,
  },
  {
    key: "live",
    label: "打开直播",
    description: "频道、分组和 EPG",
    icon: Radio,
  },
  {
    key: "favorites",
    label: "打开收藏",
    description: "管理收藏内容",
    icon: Clapperboard,
  },
  {
    key: "history",
    label: "打开播放历史",
    description: "继续最近播放",
    icon: History,
  },
  {
    key: "config",
    label: "打开配置中心",
    description: "导入并分析配置",
    icon: FileSliders,
  },
  {
    key: "settings",
    label: "打开设置",
    description: "主题、安全与存储",
    icon: Settings2,
  },
];

function App() {
  const activeView = useAppStore((state) => state.activeView);
  const theme = useAppStore((state) => state.theme);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const setTheme = useAppStore((state) => state.setTheme);
  const [commandOpen, setCommandOpen] = useState(false);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const navigate = (view: ViewKey) => {
    setActiveView(view);
    setCommandOpen(false);
  };

  return (
    <>
      <AppShell
        activeView={activeView}
        theme={theme}
        onNavigate={navigate}
        onOpenCommand={() => setCommandOpen(true)}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {activeView === "home" && <HomeView />}
        {activeView === "config" && <ConfigCenter />}
        {activeView === "settings" && (
          <SettingsView theme={theme} onThemeChange={setTheme} />
        )}
        {activeView === "browse" && <BrowseView onNavigate={navigate} />}
        {activeView === "live" && (
          <PlaceholderView
            icon={Radio}
            title="直播工作区"
            description="M3U、TXT、JSON 直播源和 EPG 会在播放层接入后显示在这里。"
            actionLabel="查看配置源"
            actionView="config"
            onAction={navigate}
          />
        )}
        {activeView === "favorites" && <FavoritesView onNavigate={navigate} />}
        {activeView === "history" && <HistoryView onNavigate={navigate} />}
      </AppShell>

      <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
        <DialogTitle className="sr-only">快速查找</DialogTitle>
        <DialogDescription className="sr-only">
          搜索 Moseek 页面和工作区动作
        </DialogDescription>
        <CommandInput placeholder="输入页面或动作..." />
        <CommandList>
          <CommandEmpty>没有找到匹配项。</CommandEmpty>
          <CommandGroup heading="页面">
            {commandItems.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.key}
                  value={`${item.label} ${item.description}`}
                  onSelect={() => navigate(item.key)}
                >
                  <Icon data-icon="inline-start" aria-hidden="true" />
                  <span className="flex flex-col gap-0.5">
                    <span>{item.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandGroup heading="快捷动作">
            <CommandItem value="search resources">
              <Search data-icon="inline-start" aria-hidden="true" />
              <span>搜索资源</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7"
                onClick={() => navigate("browse")}
              >
                打开
              </Button>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

export default App;
