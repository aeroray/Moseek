import { useState } from "react";
import {
  FileUp,
  HardDrive,
  Info,
  MonitorCog,
  Moon,
  Palette,
  Play,
  Sun,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ClearRecordsDialog,
  type ClearTarget,
} from "@/components/clear-records-dialog";
import { AppUpdatePanel } from "@/features/update/app-update-panel";
import type { FootprintKind, ThemeMode } from "@/types/moseek";

/**
 * The running version, injected at build time from `package.json`.
 *
 * Read from the bundle rather than hard-coded so it cannot drift from the version the installer and
 * the update manifest agree on — a panel that displayed a version differing from the one the updater
 * compares would make "已是最新版本" untrustworthy.
 */
const APP_VERSION = __APP_VERSION__;

interface SettingsViewProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  autoEpgEnabled: boolean;
  onAutoEpgEnabledChange: (enabled: boolean) => void;
  /**
   * Counts per kind rather than per list.
   *
   * The clear dialogs name each kind separately, and the totals shown above them are derived from
   * these, so a total can never claim more than its parts — the previous pair of flat counts let
   * the page promise it would clear both favourite lists while the store removed only one.
   */
  historyCounts: Record<FootprintKind, number>;
  favoriteCounts: Record<FootprintKind, number>;
  progressCount: number;
  onClearHistory: (kind: FootprintKind) => void;
  onClearFavorites: (kind: FootprintKind) => void;
}

/**
 * 设置中心 — the one place a user answers "what can I change?".
 *
 * Laid out like the configuration centre rather than as a stack of cards: a fixed header, a tab
 * row, and one card per tab whose body is the only scrolling region. The page itself never
 * scrolls, so the tabs stay where the user left them while they read down a long tab.
 *
 * Every control here changes something real. A switch that moves and does nothing is worse than
 * no switch at all, because it teaches the user that the application ignores them — which is why
 * the invented placeholders this page used to carry (an "interface state" table, four inert
 * player toggles, three local-network permissions, two directory paths nothing wrote to) are gone
 * rather than restyled.
 */
export function SettingsView({
  theme,
  onThemeChange,
  autoEpgEnabled,
  onAutoEpgEnabledChange,
  historyCounts,
  favoriteCounts,
  progressCount,
  onClearHistory,
  onClearFavorites,
}: SettingsViewProps) {
  const [storageMessage, setStorageMessage] = useState("");
  /** Which clear dialog is open, if any. `null` means neither. */
  const [clearKind, setClearKind] = useState<"history" | "favorites" | null>(
    null,
  );

  const historyCount = historyCounts.vod + historyCounts.live;
  const favoriteCount = favoriteCounts.vod + favoriteCounts.live;
  const historyTargets: ClearTarget<FootprintKind>[] = [
    { kind: "vod", label: "影视足迹", count: historyCounts.vod },
    { kind: "live", label: "电视直播足迹", count: historyCounts.live },
  ];
  const favoriteTargets: ClearTarget<FootprintKind>[] = [
    { kind: "vod", label: "影视收藏", count: favoriteCounts.vod },
    { kind: "live", label: "电视直播收藏", count: favoriteCounts.live },
  ];
  return (
    /* Same shell as 配置中心: the page owns no scrollbar, and the only scrolling region is inside
       the visible card. */
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4 p-5">
        <section className="flex items-center justify-between gap-4 border-b border-border/60 pb-3">
          <div>
            <h1 className="font-display text-lg font-bold tracking-tight text-foreground">
              设置中心
            </h1>
            {/* No badge beside the title. "拾影 · 偏好设置" named the product and the page in the
                same breath as the heading, and the heading already says which page this is. */}
            <p className="mt-0.5 text-xs text-muted-foreground">
              主题外观、播放引擎与网络安全控制
            </p>
          </div>
        </section>

        <Tabs
          defaultValue="appearance"
          className="flex min-h-0 flex-1 flex-col gap-4"
        >
          {/* Icons on the tabs, matching the configuration centre: a tab row that is four bare
              words takes longer to scan than four words with a shape in front of each. */}
          <TabsList className="w-fit">
            <TabsTrigger value="appearance" className="gap-1.5">
              <Palette className="size-3.5" data-icon="inline-start" aria-hidden="true" />
              外观
            </TabsTrigger>
            <TabsTrigger value="player" className="gap-1.5">
              <Play className="size-3.5" data-icon="inline-start" aria-hidden="true" />
              播放器
            </TabsTrigger>
            <TabsTrigger value="storage" className="gap-1.5">
              <HardDrive className="size-3.5" data-icon="inline-start" aria-hidden="true" />
              存储
            </TabsTrigger>
            <TabsTrigger value="about" className="gap-1.5">
              <Info className="size-3.5" data-icon="inline-start" aria-hidden="true" />
              关于
            </TabsTrigger>
          </TabsList>

          <TabsContent value="appearance" className="flex min-h-0 flex-1 flex-col">
            <SettingsCard
              title="外观"
              description="选择界面主题。设置保存在本机，立即生效并在下次启动时保留。"
            >
              <SettingRow
                icon={<MonitorCog className="size-4" aria-hidden="true" />}
                label="主题模式"
                description={
                  theme === "system"
                    ? "跟随 Windows 外观，系统切换深色时界面一起切换。"
                    : theme === "dark"
                      ? "始终使用深色界面。"
                      : "始终使用浅色界面。"
                }
                control={
                  <Select
                    value={theme}
                    onValueChange={(value) => onThemeChange(value as ThemeMode)}
                  >
                    <SelectTrigger className="w-40" aria-label="主题模式">
                      <SelectValue placeholder="选择主题" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="system">
                          <span className="flex items-center gap-2">
                            <MonitorCog className="size-4" aria-hidden="true" />
                            跟随系统
                          </span>
                        </SelectItem>
                        <SelectItem value="light">
                          <span className="flex items-center gap-2">
                            <Sun className="size-4" aria-hidden="true" />
                            浅色
                          </span>
                        </SelectItem>
                        <SelectItem value="dark">
                          <span className="flex items-center gap-2">
                            <Moon className="size-4" aria-hidden="true" />
                            深色
                          </span>
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                }
              />
            </SettingsCard>
          </TabsContent>

          <TabsContent value="player" className="flex min-h-0 flex-1 flex-col">
            <SettingsCard
              title="播放器"
              description="影响播放引擎如何取流与解析节目单。"
            >
              <SettingRow
                icon={<FileUp className="size-4" aria-hidden="true" />}
                label="自动获取节目单"
                description={
                  autoEpgEnabled
                    ? "未配置节目单的直播源会自动查询内置节目单服务，单次只请求所选频道。节目单只用于显示，不影响频道播放。"
                    : "只使用直播源自己声明的节目单地址，不连接内置服务。节目单只用于显示，不影响频道播放。"
                }
                control={
                  <Switch
                    checked={autoEpgEnabled}
                    onCheckedChange={onAutoEpgEnabledChange}
                    aria-label="自动获取节目单"
                  />
                }
              />
            </SettingsCard>
          </TabsContent>

          <TabsContent value="storage" className="flex min-h-0 flex-1 flex-col">
            <SettingsScrollBody>
              <Card className="gap-0 py-0">
                <CardHeader className="border-b pb-4 pt-5">
                  <CardTitle className="text-base">存储</CardTitle>
                  <CardDescription>
                    这些数据只保存在这台电脑上，清除后不会影响你导入的配置。
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="flex flex-col px-5">
                    <SettingsSection
                      title="本机数据"
                      description="足迹与观看进度是同一批记录的两种读法，清除其中一类会一并清掉它对应的进度。"
                    >
                      {/* Counts as tiles rather than one oversized figure: three plain numbers do
                          not need the hero-metric treatment, and the row reads as a summary. */}
                      <div className="grid grid-cols-3 gap-3">
                        <StorageStat label="足迹" value={historyCount} />
                        <StorageStat label="收藏" value={favoriteCount} />
                        <StorageStat label="观看进度" value={progressCount} />
                      </div>
                    </SettingsSection>

                    <SettingsSection title="清理" description="清除后无法恢复。">
                      <div className="flex flex-col divide-y divide-border/60">
                        <SettingRow
                          icon={<Trash2 className="size-4" aria-hidden="true" />}
                          label="清除足迹"
                          description="移除全部影视与电视直播足迹，以及它们对应的观看进度；收藏会保留。"
                          control={
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={historyCount === 0}
                              onClick={() => setClearKind("history")}
                            >
                              清除足迹
                            </Button>
                          }
                        />
                        <SettingRow
                          icon={<Trash2 className="size-4" aria-hidden="true" />}
                          label="清除收藏"
                          description="移除全部影视收藏与电视直播收藏；足迹会保留。"
                          control={
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={favoriteCount === 0}
                              onClick={() => setClearKind("favorites")}
                            >
                              清除收藏
                            </Button>
                          }
                        />
                      </div>
                      {storageMessage && (
                        <p className="text-xs text-muted-foreground">
                          {storageMessage}
                        </p>
                      )}
                    </SettingsSection>
                  </div>
                </CardContent>
              </Card>
            </SettingsScrollBody>
          </TabsContent>

          <TabsContent value="about" className="flex min-h-0 flex-1 flex-col">
            <SettingsCard
              title="关于与更新"
              description="从 GitHub Releases 检查新版本。下载的安装包会先校验签名，校验不通过不会被安装。"
            >
              <AppUpdatePanel currentVersion={APP_VERSION} />
            </SettingsCard>
          </TabsContent>
        </Tabs>
      </div>

      {/* The same dialog 足迹 and 我的收藏 open. The window previously used `window.confirm`,
          which could not show how many records each kind holds, and the two pages it was meant to
          match had a checkbox dialog the user had already asked for — so the settings page was the
          one surface still asking in a browser prompt. One dialog, opened with a different list. */}
      <ClearRecordsDialog
        open={clearKind !== null}
        onOpenChange={(open) => {
          if (!open) setClearKind(null);
        }}
        title={clearKind === "favorites" ? "清除收藏" : "清除足迹"}
        description={
          clearKind === "favorites"
            ? "选择要清除的收藏。清除后无法恢复，影视与电视直播各自独立。"
            : "选择要清除的记录。清除后无法恢复，影视与电视直播各自独立。"
        }
        targets={clearKind === "favorites" ? favoriteTargets : historyTargets}
        onConfirm={(kinds) => {
          if (clearKind === "favorites") {
            for (const kind of kinds) onClearFavorites(kind);
            setStorageMessage("已清除收藏。");
          } else {
            for (const kind of kinds) onClearHistory(kind);
            setStorageMessage("已清除足迹与观看进度。");
          }
          setClearKind(null);
        }}
      />
    </div>
  );
}

/**
 * One card per tab, sized to its content.
 *
 * Deliberately *not* stretched to fill the viewport. The configuration centre's card is full-height
 * because a table fills it; these tabs are short, and stretching the card anyway drew a large empty
 * panel under the last row that read as unfinished. The scroll region is the tab instead, so a long
 * tab (the script tools expanded) scrolls without the page growing a second scrollbar.
 */
function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b pb-4 pt-5">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {/* Horizontal padding only. The vertical rhythm comes from the child: a `SettingRow` carries
            its own `py-3.5`, and adding padding here would double it on 外观 and 播放器. A child that
            is not a row has to bring its own — see the 关于与更新 tab. */}
        <div className="flex flex-col px-5">{children}</div>
      </CardContent>
    </Card>
  );
}

/**
 * The scrolling body of a tab: caps the height and scrolls, so the tab row and the page never move.
 *
 * Used by the tabs that carry more than one group; the single-card tabs use `SettingsCard`, which
 * is not itself a scroll container.
 */
function SettingsScrollBody({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="pb-1">{children}</div>
    </ScrollArea>
  );
}

/** A labelled group inside a tab, separated from its siblings by a hairline. */
function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border/60 py-5 first:border-t-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* A heading rather than another card: nesting a card inside a card says nothing that
              this hairline and a weight step do not already say. */}
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A setting: what it is on the left, the control on the right.
 *
 * The label and the control are given the same row so the eye pairs them without reading; the
 * description sits under the label because it explains the label, not the control.
 *
 * The row carries its own vertical padding, unconditionally. It previously used `py-3.5
 * first:pt-0 last:pb-0` to sit flush inside a divided list, but on the appearance and player tabs
 * the row is simultaneously the first *and* the last child, so both rules applied and it got no
 * vertical padding at all — the control was squeezed flat against the card's header and footer,
 * which is exactly how it was reported. Edge padding on a divided list is a cosmetic nicety; losing
 * all height on a single-row card is a defect, so the unconditional value wins.
 */
function SettingRow({
  icon,
  label,
  description,
  control,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3.5">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {description && (
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

function StorageStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-nums text-foreground">
        {value}
      </p>
    </div>
  );
}
