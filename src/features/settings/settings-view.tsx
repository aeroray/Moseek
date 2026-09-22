import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FileUp,
  HardDrive,
  MonitorCog,
  Moon,
  Palette,
  Play,
  ShieldCheck,
  ShieldX,
  Sun,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  deleteScriptArchive,
  executeScriptArchive,
  isTauriRuntime,
  listScriptExecutionLogs,
  listScriptArchives,
  purgeScriptArchive,
  restoreScriptArchive,
  saveScriptArchive,
  setScriptArchiveEnabled,
} from "@/lib/tauri";
import type { ScriptExecutionLog } from "@/lib/tauri";
import { cn, errorMessage } from "@/lib/utils";
import type {
  FootprintKind,
  ScriptArchiveSummary,
  ThemeMode,
} from "@/types/moseek";

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
 * 系统设置 — the one place a user answers "what can I change?".
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
  /**
   * The script-archive tooling is off by default. It is a power-user feature — most sources work
   * without it, and the fields it asks for (entry function, HTTP allowlist, module map) are not
   * meaningful to someone who just wants to watch something. Hiding it behind a disclosure keeps
   * the settings page answerable for an ordinary user.
   */
  const [showScriptTools, setShowScriptTools] = useState(false);
  const [isExecutingScript, setIsExecutingScript] = useState(false);
  const [scriptArchives, setScriptArchives] = useState<ScriptArchiveSummary[]>([]);
  const [scriptExecutionLogs, setScriptExecutionLogs] = useState<
    ScriptExecutionLog[]
  >([]);
  const [isLoadingArchives, setIsLoadingArchives] = useState(false);
  const [archiveMessage, setArchiveMessage] = useState("");
  const [deletedArchiveId, setDeletedArchiveId] = useState<number | null>(null);
  const [archiveEntry, setArchiveEntry] = useState("main");
  const [archiveHttpHosts, setArchiveHttpHosts] = useState("");
  const [archiveHeaders, setArchiveHeaders] = useState("");
  const [archiveModules, setArchiveModules] = useState("");
  const scriptFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    setIsLoadingArchives(true);
    void listScriptArchives()
      .then((archives) => setScriptArchives(archives ?? []))
      .catch((error) => {
        setArchiveMessage(errorMessage(error, "无法读取脚本档案"));
      })
      .finally(() => setIsLoadingArchives(false));
    void listScriptExecutionLogs(8)
      .then((logs) => setScriptExecutionLogs(logs ?? []))
      .catch(() => setScriptExecutionLogs([]));
  }, []);

  const refreshScriptExecutionLogs = () => {
    void listScriptExecutionLogs(8)
      .then((logs) => {
        if (logs) setScriptExecutionLogs(logs);
      })
      .catch(() => undefined);
  };

  const handleImportScriptArchive = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setArchiveMessage("");
    try {
      const saved = await saveScriptArchive({
        name: file.name.replace(/\.(m?js|txt)$/i, "") || file.name,
        fileName: file.name,
        script: await file.text(),
        entry: archiveEntry.trim() || "main",
        httpHosts: archiveHttpHosts
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
        httpHeaders: archiveHeaders.trim()
          ? (JSON.parse(archiveHeaders) as Record<string, string>)
          : {},
        modules: archiveModules.trim()
          ? (JSON.parse(archiveModules) as Record<string, string>)
          : {},
      });
      if (!saved)
        throw new Error(
          "浏览器预览不会保存脚本档案，请在 Tauri 桌面应用中使用。",
        );
      setScriptArchives((archives) => [saved, ...archives]);
      setDeletedArchiveId(null);
      setArchiveMessage(`已导入「${saved.name}」，默认保持停用。`);
    } catch (error) {
      setArchiveMessage(errorMessage(error, "脚本档案导入失败"));
    }
  };

  const handleToggleScriptArchive = async (
    archive: ScriptArchiveSummary,
    enabled: boolean,
  ) => {
    try {
      const updated = await setScriptArchiveEnabled(archive.id, enabled);
      if (!updated) throw new Error("浏览器预览不会修改脚本档案。");
      setScriptArchives((archives) =>
        archives.map((item) => (item.id === updated.id ? updated : item)),
      );
      setArchiveMessage(
        enabled ? `已启用「${archive.name}」。` : `已停用「${archive.name}」。`,
      );
    } catch (error) {
      setArchiveMessage(errorMessage(error, "脚本档案状态保存失败"));
    }
  };

  const handleDeleteScriptArchive = async (archive: ScriptArchiveSummary) => {
    if (!window.confirm(`确认删除本地脚本档案「${archive.name}」？`)) return;
    try {
      const archives = await deleteScriptArchive(archive.id);
      if (!archives) throw new Error("浏览器预览不会删除脚本档案。");
      setScriptArchives(archives);
      setDeletedArchiveId(archive.id);
      setArchiveMessage(`已删除「${archive.name}」；原始配置没有变化。`);
    } catch (error) {
      setArchiveMessage(errorMessage(error, "脚本档案删除失败"));
    }
  };

  const handleRestoreScriptArchive = async () => {
    if (deletedArchiveId === null) return;
    try {
      const archives = await restoreScriptArchive(deletedArchiveId);
      if (!archives) throw new Error("浏览器预览不会恢复脚本档案。");
      setScriptArchives(archives);
      setDeletedArchiveId(null);
      setArchiveMessage("已撤销删除，脚本档案已恢复并保持原启用状态。");
    } catch (error) {
      setArchiveMessage(errorMessage(error, "脚本档案恢复失败"));
    }
  };

  const handlePurgeScriptArchive = async (archive: ScriptArchiveSummary) => {
    if (archive.enabled) {
      setArchiveMessage("请先停用脚本档案，再永久删除。");
      return;
    }
    if (
      !window.confirm(
        `永久删除「${archive.name}」？这会同时清理 Windows 凭据存储中的 Cookie，不能撤销。`,
      )
    ) {
      return;
    }
    try {
      const archives = await purgeScriptArchive(archive.id);
      if (!archives) throw new Error("浏览器预览不会永久删除脚本档案。");
      setScriptArchives(archives);
      setArchiveMessage(`已永久删除「${archive.name}」及其安全凭据。`);
    } catch (error) {
      setArchiveMessage(errorMessage(error, "脚本档案永久删除失败"));
    }
  };

  const handleExecuteScriptArchive = async (archive: ScriptArchiveSummary) => {
    if (isExecutingScript || !archive.enabled) return;
    setIsExecutingScript(true);
    setArchiveMessage("");
    try {
      // The archive is invoked with an empty input: this button exists to confirm the script
      // runs at all, not to drive it with a payload. The real inputs come from whichever source
      // is bound to the archive, at browse time.
      const result = await executeScriptArchive(archive.id, {});
      if (!result) throw new Error("浏览器预览不会执行脚本档案。");
      setArchiveMessage(
        `「${archive.name}」执行成功：${result.httpCallCount} 次网络调用。`,
      );
      const archives = await listScriptArchives();
      if (archives) setScriptArchives(archives);
      refreshScriptExecutionLogs();
    } catch (error) {
      setArchiveMessage(
        `「${archive.name}」执行失败：${errorMessage(error, "未知错误")}`,
      );
      refreshScriptExecutionLogs();
    } finally {
      setIsExecutingScript(false);
    }
  };

  return (
    /* Same shell as 配置中心: the page owns no scrollbar, and the only scrolling region is inside
       the visible card. */
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4 p-5">
        <section className="flex items-center justify-between gap-4 border-b border-border/60 pb-3">
          <div>
            <h1 className="font-display text-lg font-bold tracking-tight text-foreground">
              系统设置
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
            <TabsTrigger value="security" className="gap-1.5">
              <ShieldCheck className="size-3.5" data-icon="inline-start" aria-hidden="true" />
              安全与网络
            </TabsTrigger>
            <TabsTrigger value="storage" className="gap-1.5">
              <HardDrive className="size-3.5" data-icon="inline-start" aria-hidden="true" />
              存储
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

          <TabsContent
            value="security"
            className="flex min-h-0 flex-1 flex-col"
          >
            <SettingsScrollBody>
              <Card className="gap-0 py-0">
                <CardHeader className="border-b pb-4 pt-5">
                  <CardTitle className="text-base">安全与网络</CardTitle>
                  <CardDescription>
                    执行边界由程序固定，导入的配置无法改变；脚本能力默认收起。
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="flex flex-col px-5">
                    {/* The boundary is a statement of fact, not a set of switches. These were
                        offered as permissions in an earlier version and could not be honoured —
                        the addresses are refused by a fixed policy rule — so they are enumerated
                        as rules instead. */}
                    <SettingsSection
                      title="执行边界"
                      description="这些规则由程序固定，导入配置无法改变。"
                    >
                      <ul className="flex flex-col gap-2.5">
                        {[
                          "远程 JavaScript、JAR 和 spider 默认阻止",
                          "本机与局域网地址默认拒绝访问",
                          "日志会隐藏 token、Cookie 和密钥",
                        ].map((rule) => (
                          <li
                            key={rule}
                            className="flex items-start gap-2 text-sm text-muted-foreground"
                          >
                            <Check
                              className="mt-0.5 size-4 shrink-0 text-[color:var(--status-supported)]"
                              aria-hidden="true"
                            />
                            {rule}
                          </li>
                        ))}
                      </ul>
                    </SettingsSection>

                    <SettingsSection
                      title="本地脚本档案"
                      description="面向进阶用法：让使用 CatVod 脚本契约的源在本机执行。普通用户不需要配置，绝大多数源无需脚本即可使用。"
                      action={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="shrink-0 gap-1.5"
                          aria-expanded={showScriptTools}
                          onClick={() => setShowScriptTools((value) => !value)}
                        >
                          {showScriptTools ? "收起" : "展开"}
                          <ChevronDown
                            className={cn(
                              "size-3.5 transition-transform duration-200",
                              showScriptTools && "rotate-180",
                            )}
                            data-icon="inline-end"
                            aria-hidden="true"
                          />
                        </Button>
                      }
                    >
                      {showScriptTools && (
                        <div className="flex flex-col gap-3">
                          <input
                            ref={scriptFileInputRef}
                            type="file"
                            accept=".js,.mjs,.txt,text/javascript"
                            className="hidden"
                            onChange={(event) =>
                              void handleImportScriptArchive(event)
                            }
                          />
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-xs text-muted-foreground">
                              {isLoadingArchives
                                ? "正在读取档案..."
                                : `${scriptArchives.length} 个本地档案`}
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="gap-1.5"
                              onClick={() => scriptFileInputRef.current?.click()}
                              disabled={!isTauriRuntime() || isLoadingArchives}
                            >
                              <FileUp
                                className="size-3.5"
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                              导入本地脚本
                            </Button>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <Input
                              value={archiveEntry}
                              onChange={(event) =>
                                setArchiveEntry(event.target.value)
                              }
                              placeholder="入口函数，例如 main"
                              aria-label="脚本档案入口函数"
                              className="font-mono text-xs"
                            />
                            <Input
                              value={archiveHttpHosts}
                              onChange={(event) =>
                                setArchiveHttpHosts(event.target.value)
                              }
                              placeholder="HTTP allowlist，逗号分隔；留空禁止网络"
                              aria-label="脚本档案 HTTP allowlist"
                              className="font-mono text-xs"
                            />
                            <Textarea
                              value={archiveHeaders}
                              onChange={(event) =>
                                setArchiveHeaders(event.target.value)
                              }
                              placeholder='请求头 JSON，例如 {"Referer":"https://example.com","User-Agent":"Moseek"}'
                              aria-label="脚本档案请求头"
                              className="col-span-2 min-h-16 font-mono text-xs"
                            />
                            <Textarea
                              value={archiveModules}
                              onChange={(event) =>
                                setArchiveModules(event.target.value)
                              }
                              placeholder='内存模块 JSON，例如 {"math.js":"export function add(value) { return value + 1; }"}'
                              aria-label="脚本档案内存模块"
                              className="col-span-2 min-h-16 font-mono text-xs"
                            />
                          </div>

                          {scriptArchives.length > 0 && (
                            <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-md border">
                              {scriptArchives.map((archive) => (
                                <li
                                  key={archive.id}
                                  className="flex items-center gap-3 px-3 py-2.5"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-foreground">
                                      {archive.name}
                                    </p>
                                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                                      {archive.fileName} · sha256{" "}
                                      {archive.sha256.slice(0, 16)}…
                                    </p>
                                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                                      <Badge
                                        variant={
                                          archive.enabled ? "default" : "outline"
                                        }
                                      >
                                        {archive.enabled ? "已启用" : "已停用"}
                                      </Badge>
                                      {archive.httpHeaderNames.length > 0 && (
                                        <Badge variant="outline">
                                          请求头 {archive.httpHeaderNames.length}
                                        </Badge>
                                      )}
                                      {archive.hasCookie && (
                                        <Badge variant="outline">
                                          Cookie 已保护
                                        </Badge>
                                      )}
                                      {archive.moduleNames.length > 0 && (
                                        <Badge variant="outline">
                                          内存模块 {archive.moduleNames.length}
                                        </Badge>
                                      )}
                                    </div>
                                  </div>
                                  <Switch
                                    checked={archive.enabled}
                                    onCheckedChange={(enabled) =>
                                      void handleToggleScriptArchive(
                                        archive,
                                        enabled,
                                      )
                                    }
                                    aria-label={`${archive.enabled ? "停用" : "启用"} ${archive.name}`}
                                  />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="gap-1.5"
                                    disabled={
                                      !archive.enabled || isExecutingScript
                                    }
                                    onClick={() =>
                                      void handleExecuteScriptArchive(archive)
                                    }
                                  >
                                    <Play
                                      className="size-3.5"
                                      data-icon="inline-start"
                                      aria-hidden="true"
                                    />
                                    执行
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="gap-1.5 text-muted-foreground"
                                    aria-label={`移除 ${archive.name}`}
                                    onClick={() =>
                                      void handleDeleteScriptArchive(archive)
                                    }
                                  >
                                    <ShieldX
                                      className="size-3.5"
                                      data-icon="inline-start"
                                      aria-hidden="true"
                                    />
                                    移除
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    title="永久删除并清理安全凭据"
                                    aria-label={`永久删除 ${archive.name}`}
                                    disabled={archive.enabled}
                                    onClick={() =>
                                      void handlePurgeScriptArchive(archive)
                                    }
                                    className="gap-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                  >
                                    <Trash2
                                      className="size-3.5"
                                      data-icon="inline-start"
                                      aria-hidden="true"
                                    />
                                    彻底删除
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          )}

                          {archiveMessage && (
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs text-muted-foreground">
                                {archiveMessage}
                              </p>
                              {deletedArchiveId !== null && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    void handleRestoreScriptArchive()
                                  }
                                >
                                  撤销删除
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </SettingsSection>

                    <SettingsSection
                      title="脚本执行诊断"
                      description="脚本在受限运行时中执行：无文件、Shell、DOM 权限，HTTP 主机必须显式列入 allowlist。这里只显示执行记录。"
                    >
                      {scriptExecutionLogs.length === 0 ? (
                        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                          暂无脚本执行记录。
                        </p>
                      ) : (
                        <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-md border">
                          {scriptExecutionLogs.slice(0, 4).map((log) => (
                            <li
                              key={log.id}
                              className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs"
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <Badge variant={diagnosticStatusVariant(log.status)}>
                                  {diagnosticStatusLabel(log.status)}
                                </Badge>
                                <span className="truncate text-muted-foreground">
                                  {diagnosticPhaseLabel(log.phase)} ·{" "}
                                  {log.durationMs} ms
                                </span>
                              </div>
                              <span className="shrink-0 font-mono text-muted-foreground">
                                {log.httpCallCount} 次请求
                                {log.errorKind
                                  ? ` · ${diagnosticErrorLabel(log.errorKind)}`
                                  : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </SettingsSection>
                  </div>
                </CardContent>
              </Card>
            </SettingsScrollBody>
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

function diagnosticStatusLabel(status: string) {
  return status === "ok" ? "成功" : "失败";
}

function diagnosticStatusVariant(status: string) {
  return status === "ok" ? "default" : "destructive";
}

function diagnosticPhaseLabel(phase: string) {
  const labels: Record<string, string> = {
    complete: "完成",
    credential: "凭据读取",
    entry: "入口执行",
    "host-call": "网络调用",
    runtime: "运行时",
    spawn: "启动",
    timeout: "超时",
  };
  return labels[phase] ?? phase;
}

function diagnosticErrorLabel(errorKind: string) {
  const labels: Record<string, string> = {
    credential: "凭据错误",
    entry: "入口错误",
    http: "网络错误",
    runtime: "运行时错误",
    script: "脚本错误",
    timeout: "执行超时",
  };
  return labels[errorKind] ?? errorKind;
}
