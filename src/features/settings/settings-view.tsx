import { useEffect, useRef, useState } from "react";
import {
  Check,
  FileUp,
  MonitorCog,
  Moon,
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
import type { ScriptArchiveSummary, ThemeMode } from "@/types/moseek";

interface SettingsViewProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  autoEpgEnabled: boolean;
  onAutoEpgEnabledChange: (enabled: boolean) => void;
  historyCount: number;
  favoriteCount: number;
  progressCount: number;
  onClearHistory: () => void;
  onClearFavorites: () => void;
}

export function SettingsView({
  theme,
  onThemeChange,
  autoEpgEnabled,
  onAutoEpgEnabledChange,
  historyCount,
  favoriteCount,
  progressCount,
  onClearHistory,
  onClearFavorites,
}: SettingsViewProps) {
  const [storageMessage, setStorageMessage] = useState("");
  /**
   * The script-archive tooling is off by default. It is a power-user feature — most sources work
   * without it, and the fields it asks for (entry function, HTTP allowlist, module map) are not
   * meaningful to someone who just wants to watch something. Hiding it behind a disclosure keeps
   * the settings page answerable for an ordinary user.
   */
  const [showScriptTools, setShowScriptTools] = useState(false);
  const [isExecutingScript, setIsExecutingScript] = useState(false);
  const [scriptArchives, setScriptArchives] = useState<ScriptArchiveSummary[]>(
    [],
  );
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
        setArchiveMessage(
          error instanceof Error ? error.message : "无法读取脚本档案",
        );
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
      setArchiveMessage(
        error instanceof Error ? error.message : "脚本档案导入失败",
      );
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
      setArchiveMessage(
        error instanceof Error ? error.message : "脚本档案状态保存失败",
      );
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
      setArchiveMessage(
        error instanceof Error ? error.message : "脚本档案删除失败",
      );
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
      setArchiveMessage(
        error instanceof Error ? error.message : "脚本档案恢复失败",
      );
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
      setArchiveMessage(
        error instanceof Error ? error.message : "脚本档案永久删除失败",
      );
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
        `「${archive.name}」执行失败：${
          error instanceof Error ? error.message : "未知错误"
        }`,
      );
      refreshScriptExecutionLogs();
    } finally {
      setIsExecutingScript(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-5">
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-lg font-bold tracking-tight text-foreground">
                系统设置
              </h1>
              <Badge variant="secondary">拾影 · 偏好设置</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              万千影视，一拾即得 · 主题外观、播放引擎与网络安全控制
            </p>
          </div>
        </div>

        <Tabs defaultValue="appearance" className="flex flex-col gap-4">
          <TabsList className="w-fit">
            <TabsTrigger value="appearance">外观</TabsTrigger>
            <TabsTrigger value="player">播放器</TabsTrigger>
            <TabsTrigger value="security">安全与网络</TabsTrigger>
            <TabsTrigger value="storage">存储</TabsTrigger>
          </TabsList>

          <TabsContent value="appearance">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <MonitorCog className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                  主题模式
                </CardTitle>
                <CardDescription>默认跟随 Windows 系统外观。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Select
                  value={theme}
                  onValueChange={(value) => onThemeChange(value as ThemeMode)}
                >
                  <SelectTrigger className="w-full max-w-sm">
                    <SelectValue placeholder="选择主题" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="system">
                        <span className="flex items-center gap-2">
                          <MonitorCog
                            className="size-4"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          跟随系统
                        </span>
                      </SelectItem>
                      <SelectItem value="light">
                        <span className="flex items-center gap-2">
                          <Sun className="size-4" data-icon="inline-start" aria-hidden="true" />
                          浅色
                        </span>
                      </SelectItem>
                      <SelectItem value="dark">
                        <span className="flex items-center gap-2">
                          <Moon className="size-4" data-icon="inline-start" aria-hidden="true" />
                          深色
                        </span>
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <p className="text-xs leading-5 text-muted-foreground">
                  应用会在下次启动时保留你的选择。
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="player" className="grid grid-cols-2 gap-6">
            <PreferenceCard
              className="col-span-2"
              title="电视直播节目单"
              description="节目单只用于显示，不影响频道播放"
            >
              <PreferenceRow
                label="自动获取节目单"
                checked={autoEpgEnabled}
                onCheckedChange={onAutoEpgEnabledChange}
                description={
                  autoEpgEnabled
                    ? "未配置 EPG 的直播源会自动使用内置节目单源（epg.112114.xyz）查询当前频道，单次仅请求所选频道。"
                    : "仅使用直播源自己声明的 EPG 地址，不连接内置节目单源。"
                }
              />
            </PreferenceCard>
          </TabsContent>

          <TabsContent value="security">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                  执行边界
                </CardTitle>
                <CardDescription>
                  这些规则由程序固定，导入配置无法改变。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
                <p className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 shrink-0 text-[color:var(--status-supported)]"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  远程 JavaScript、JAR 和 spider 默认阻止
                </p>
                <p className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 shrink-0 text-[color:var(--status-supported)]"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  本机与局域网地址默认拒绝访问
                </p>
                <p className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 shrink-0 text-[color:var(--status-supported)]"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  日志会隐藏 token、Cookie 和密钥
                </p>
              </CardContent>
            </Card>
            <Card className="col-span-2">
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1.5">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileUp className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                      本地脚本档案
                    </CardTitle>
                    <CardDescription>
                      面向进阶用法：让使用 CatVod 脚本契约的源在本机执行。
                      普通用户不需要配置，绝大多数源无需脚本即可使用。
                    </CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    aria-expanded={showScriptTools}
                    onClick={() => setShowScriptTools((value) => !value)}
                  >
                    {showScriptTools ? "收起" : "展开"}
                  </Button>
                </div>
              </CardHeader>
              {showScriptTools && (
                <CardContent className="flex flex-col gap-3">
                <input
                  ref={scriptFileInputRef}
                  type="file"
                  accept=".js,.mjs,.txt,text/javascript"
                  className="hidden"
                  onChange={(event) => void handleImportScriptArchive(event)}
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
                    <FileUp className="size-4" data-icon="inline-start" aria-hidden="true" />
                    导入本地脚本
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    value={archiveEntry}
                    onChange={(event) => setArchiveEntry(event.target.value)}
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
                    onChange={(event) => setArchiveHeaders(event.target.value)}
                    placeholder='请求头 JSON，例如 {"Referer":"https://example.com","User-Agent":"Moseek"}'
                    aria-label="脚本档案请求头"
                    className="col-span-2 min-h-16 font-mono text-xs"
                  />
                  <Textarea
                    value={archiveModules}
                    onChange={(event) => setArchiveModules(event.target.value)}
                    placeholder='内存模块 JSON，例如 {"math.js":"export function add(value) { return value + 1; }"}'
                    aria-label="脚本档案内存模块"
                    className="col-span-2 min-h-16 font-mono text-xs"
                  />
                </div>
                {scriptArchives.length > 0 && (
                  <div className="flex flex-col divide-y rounded-md border">
                    {scriptArchives.map((archive) => (
                      <div
                        key={archive.id}
                        className="flex items-center gap-3 px-3 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {archive.name}
                          </p>
                          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                            {archive.fileName} · sha256{" "}
                            {archive.sha256.slice(0, 16)}…
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <Badge
                              variant={archive.enabled ? "default" : "outline"}
                            >
                              {archive.enabled ? "已启用" : "已停用"}
                            </Badge>
                            {archive.httpHeaderNames.length > 0 && (
                              <Badge variant="outline">
                                请求头 {archive.httpHeaderNames.length}
                              </Badge>
                            )}
                            {archive.hasCookie && (
                              <Badge variant="outline">Cookie 已保护</Badge>
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
                            void handleToggleScriptArchive(archive, enabled)
                          }
                          aria-label={`${archive.enabled ? "停用" : "启用"} ${archive.name}`}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={!archive.enabled || isExecutingScript}
                          onClick={() =>
                            void handleExecuteScriptArchive(archive)
                          }
                        >
                          <Play className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                          执行
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`删除 ${archive.name}`}
                          onClick={() =>
                            void handleDeleteScriptArchive(archive)
                          }
                        >
                          <ShieldX
                            className="size-4"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon-sm"
                          title="永久删除并清理安全凭据"
                          aria-label={`永久删除 ${archive.name}`}
                          disabled={archive.enabled}
                          onClick={() => void handlePurgeScriptArchive(archive)}
                        >
                          <Trash2 className="size-4" data-icon="inline-start" aria-hidden="true" />
                        </Button>
                      </div>
                    ))}
                  </div>
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
                        onClick={() => void handleRestoreScriptArchive()}
                      >
                        撤销删除
                      </Button>
                    )}
                  </div>
                )}
                </CardContent>
              )}
            </Card>
            <Card className="col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck data-icon="inline-start" aria-hidden="true" />
                  脚本执行诊断
                </CardTitle>
                <CardDescription>
                  脚本在受限运行时中执行：无文件、Shell、DOM 权限，HTTP
                  主机必须显式列入 allowlist。这里只显示执行记录。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {scriptExecutionLogs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    暂无脚本执行记录。
                  </p>
                ) : (
                  <div className="flex flex-col gap-2 rounded-md border p-3">
                    {scriptExecutionLogs.slice(0, 4).map((log) => (
                      <div
                        key={log.id}
                        className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <Badge variant={diagnosticStatusVariant(log.status)}>
                            {diagnosticStatusLabel(log.status)}
                          </Badge>
                          <span className="truncate">
                            {diagnosticPhaseLabel(log.phase)} · {log.durationMs} ms
                          </span>
                        </div>
                        <span className="shrink-0 font-mono">
                          {log.httpCallCount} 次请求
                          {log.errorKind
                            ? ` · ${diagnosticErrorLabel(log.errorKind)}`
                            : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="storage">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Trash2 className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                  本地数据
                </CardTitle>
                <CardDescription>
                  这些数据保存在本机，清除后不会影响你导入的配置文件。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-3">
                  <StorageStat label="播放记录" value={historyCount} />
                  <StorageStat label="收藏" value={favoriteCount} />
                  <StorageStat label="观看进度" value={progressCount} />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={historyCount === 0}
                    onClick={() => {
                      if (!window.confirm("清除全部播放记录与观看进度？收藏会保留。")) {
                        return;
                      }
                      onClearHistory();
                      setStorageMessage("已清除播放记录与观看进度。");
                    }}
                  >
                    清除播放记录
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={favoriteCount === 0}
                    onClick={() => {
                      if (!window.confirm("清除全部收藏？播放记录会保留。")) return;
                      onClearFavorites();
                      setStorageMessage("已清除收藏。");
                    }}
                  >
                    清除收藏
                  </Button>
                  {storageMessage && (
                    <p className="text-xs text-muted-foreground">
                      {storageMessage}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function StorageStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-muted/25 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-lg font-semibold tabular-nums">
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

function PreferenceCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">{children}</CardContent>
    </Card>
  );
}

function PreferenceRow({
  label,
  checked = false,
  onCheckedChange,
  description,
}: {
  label: string;
  checked?: boolean;
  /**
   * Supplying this makes the row a real setting rather than a placeholder. The other rows in
   * this view are still inert UI, so only pass it where the value is genuinely persisted.
   */
  onCheckedChange?: (checked: boolean) => void;
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md px-2 py-3 hover:bg-muted/50">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        {description && (
          <span className="text-xs leading-5 text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      {onCheckedChange ? (
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={label}
        />
      ) : (
        <Switch defaultChecked={checked} aria-label={label} />
      )}
    </div>
  );
}
