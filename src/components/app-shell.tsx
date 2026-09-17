import type { ReactNode } from "react";
import {
  Clapperboard,
  FileSliders,
  History,
  Library,
  Radio,
  Settings2,
  type LucideIcon,
} from "lucide-react";

import { AppLogo } from "@/components/app-logo";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import type { ViewKey } from "@/types/moseek";

interface AppShellProps {
  activeView: ViewKey;
  children: ReactNode;
  onNavigate: (view: ViewKey) => void;
}

interface NavItem {
  key: ViewKey;
  label: string;
  icon: LucideIcon;
  badge?: number | string;
}

const mainNavItems: NavItem[] = [
  { key: "browse", label: "影视库", icon: Library },
  { key: "live", label: "电视直播", icon: Radio },
  { key: "favorites", label: "我的收藏", icon: Clapperboard },
  { key: "history", label: "播放历史", icon: History },
];

const systemNavItems: NavItem[] = [
  { key: "config", label: "配置中心", icon: FileSliders },
  { key: "settings", label: "设置中心", icon: Settings2 },
];

export function AppShell({ activeView, children, onNavigate }: AppShellProps) {
  const sourceCount = useAppStore((state) => state.sources.length);
  const favoritesCount = useAppStore((state) => state.favorites.length);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-screen min-h-[640px] min-w-[1080px] bg-background text-foreground antialiased selection:bg-primary/20 selection:text-primary">
        {/* 54px Ultra-Slim Rail (方案一：极光黑曜微轨) */}
        <aside
          className="relative z-40 flex w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar/95 py-3 select-none backdrop-blur-md"
          data-tauri-drag-region
        >
          {/* Brand Mark. The wordmark is replaced by the product's own logo, so the rail shows
              the same mark as the window and the installer rather than a stand-in glyph. */}
          <div className="mb-4 flex flex-col items-center">
            <button
              type="button"
              onClick={() => onNavigate("browse")}
              className="group relative flex size-9 items-center justify-center rounded-lg transition-transform duration-200 hover:scale-105 active:scale-95"
              title="拾影 · 万千影视，一拾即得"
              aria-label="拾影 · 返回影视库"
            >
              <AppLogo className="size-9 rounded-lg" />
              <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-primary animate-pulse" />
            </button>
          </div>

          {/* Main Navigation Rail */}
          <nav className="flex flex-1 flex-col items-center gap-1.5" aria-label="核心导航">
            {mainNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = item.key === activeView;
              const hasBadge = item.key === "favorites" && favoritesCount > 0;

              return (
                <Tooltip key={item.key}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onNavigate(item.key)}
                      aria-label={item.label}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative flex size-9 items-center justify-center rounded-md text-sidebar-foreground/60 transition-all duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-95",
                        isActive &&
                          "bg-primary/15 text-primary shadow-xs hover:bg-primary/20 hover:text-primary font-semibold before:absolute before:left-[-6px] before:h-4 before:w-1 before:rounded-r-full before:bg-primary",
                      )}
                    >
                      <Icon className={cn("size-4 transition-transform duration-150", isActive && "scale-110")} />
                      {hasBadge && (
                        <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={12} className="font-medium">
                    {item.label}
                    {hasBadge && ` (${favoritesCount})`}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </nav>

          {/* System & Settings Rail Bottom */}
          <div className="flex flex-col items-center gap-1.5 pt-2 border-t border-sidebar-border/60">
            {systemNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = item.key === activeView;
              const hasCount = item.key === "config" && sourceCount > 0;

              return (
                <Tooltip key={item.key}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onNavigate(item.key)}
                      aria-label={item.label}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative flex size-9 items-center justify-center rounded-md text-sidebar-foreground/60 transition-all duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-95",
                        isActive &&
                          "bg-primary/15 text-primary shadow-xs hover:bg-primary/20 hover:text-primary font-semibold before:absolute before:left-[-6px] before:h-4 before:w-1 before:rounded-r-full before:bg-primary",
                      )}
                    >
                      <Icon className={cn("size-4 transition-transform duration-150", isActive && "scale-110")} />
                      {hasCount && (
                        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sidebar-accent px-1 text-xs font-bold text-sidebar-accent-foreground">
                          {sourceCount}
                        </span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={12} className="font-medium">
                    {item.label}
                    {hasCount && ` (${sourceCount} 个源)`}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </aside>

        {/* Main Work Area */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>
        </section>
      </div>
    </TooltipProvider>
  );
}
