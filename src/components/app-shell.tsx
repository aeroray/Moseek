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
import { WindowControls } from "@/components/window-controls";
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
  // "足迹" rather than "播放历史": it is shorter, reads as a trail rather than a log, and matches
  // what the page now shows — where you have been, in order.
  { key: "history", label: "足迹", icon: History },
];

const systemNavItems: NavItem[] = [
  { key: "config", label: "配置中心", icon: FileSliders },
  { key: "settings", label: "设置中心", icon: Settings2 },
];

export function AppShell({ activeView, children, onNavigate }: AppShellProps) {
  const sourceCount = useAppStore((state) => state.sources.length);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-screen min-h-[640px] min-w-[1080px] bg-background text-foreground antialiased selection:bg-primary/20 selection:text-primary">
        {/* The window's own chrome, drawn inside the content area.
            `decorations` is off in `tauri.conf.json`, so this row is the only place the window can be
            dragged and closed — but it carries **no text at all**. The native title bar repeated the
            product's English name, its Chinese name and its slogan above a window that already showed
            all three; repeating any of them here would be the same mistake in a different bar. The
            mark alone identifies the app, and the slogan survives as its tooltip. */}
        <div
          className="flex h-9 shrink-0 items-center border-b border-sidebar-border bg-sidebar/95 select-none backdrop-blur-md"
          data-tauri-drag-region
        >
          {/* Sized to the rail below so the mark sits directly above the navigation it belongs to,
              rather than at an arbitrary offset that would read as a stray icon. */}
          <div
            className="flex w-14 shrink-0 items-center justify-center"
            data-tauri-drag-region
          >
            <AppLogo
              className="size-5 rounded"
              title="拾影 · 万千影视，一拾即得"
            />
          </div>
          <div className="flex-1" data-tauri-drag-region />
          <WindowControls className="pr-1.5" />
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 54px Ultra-Slim Rail (方案一：极光黑曜微轨) */}
          <aside
            className="relative z-40 flex w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar/95 py-3 select-none backdrop-blur-md"
            data-tauri-drag-region
          >
            {/* Main Navigation Rail */}
            <nav className="flex flex-1 flex-col items-center gap-1.5" aria-label="核心导航">
            {mainNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = item.key === activeView;

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
                      {/* No favourites dot. A permanent mark on an icon that is not asking for
                          attention reads as an alert, and there is nothing to act on — the count
                          is already in the tooltip. */}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={12} className="font-medium">
                    {item.label}
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
      </div>
    </TooltipProvider>
  );
}
