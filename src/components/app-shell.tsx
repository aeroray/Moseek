import type { ReactNode } from "react";
import {
  Clapperboard,
  FileSliders,
  History,
  Library,
  Radio,
  Settings2,
  Video,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import type { ViewKey } from "@/types/moseek";

interface AppShellProps {
  activeView: ViewKey;
  children: ReactNode;
  onNavigate: (view: ViewKey) => void;
}

interface NavigationItem {
  key: ViewKey;
  label: string;
  icon: LucideIcon;
}

const navigationGroups: { label: string; items: NavigationItem[] }[] = [
  {
    label: "工作区",
    items: [
      { key: "browse", label: "影视库", icon: Library },
      { key: "live", label: "直播", icon: Radio },
    ],
  },
  {
    label: "我的内容",
    items: [
      { key: "favorites", label: "收藏", icon: Clapperboard },
      { key: "history", label: "播放历史", icon: History },
    ],
  },
  {
    label: "系统",
    items: [
      { key: "config", label: "配置中心", icon: FileSliders },
      { key: "settings", label: "设置", icon: Settings2 },
    ],
  },
];

export function AppShell({ activeView, children, onNavigate }: AppShellProps) {
  const sourceCount = useAppStore((state) => state.sources.length);

  return (
    <div className="flex h-screen min-h-[720px] min-w-[1200px] bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4">
        <div className="flex items-center gap-3 px-3 pb-7">
          <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
            <Video data-icon="inline-start" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="font-display text-base font-semibold tracking-tight text-sidebar-foreground">
              Moseek
            </p>
            <p className="text-xs text-muted-foreground">内容操作台</p>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-6" aria-label="主导航">
          {navigationGroups.map((group) => (
            <div key={group.label} className="flex flex-col gap-2">
              <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {group.label}
              </p>
              <div className="flex flex-col gap-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = item.key === activeView;
                  return (
                    <Button
                      key={item.key}
                      type="button"
                      variant="ghost"
                      className={cn(
                        "h-10 justify-start gap-3 rounded-md px-3 text-sm font-medium text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                        isActive &&
                          "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm hover:bg-sidebar-primary hover:text-sidebar-primary-foreground",
                      )}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => onNavigate(item.key)}
                    >
                      <Icon data-icon="inline-start" aria-hidden="true" />
                      <span>{item.label}</span>
                      {item.key === "config" && (
                        <span className="ml-auto rounded-full bg-sidebar-accent px-2 py-0.5 text-[10px] font-semibold text-sidebar-accent-foreground">
                          {sourceCount}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex flex-col gap-3 rounded-lg border border-sidebar-border bg-sidebar-accent/50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-sidebar-foreground">
              本地工作区
            </span>
            <span className="size-2 rounded-full bg-[color:var(--status-supported)]" />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            数据保存在本机。远程脚本与 JAR 默认不执行。
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full justify-between border-sidebar-border bg-sidebar"
            onClick={() => onNavigate("settings")}
          >
            工作区设置
            <Settings2 data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1">{children}</main>
      </section>
    </div>
  );
}
