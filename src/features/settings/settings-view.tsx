import { useEffect, useRef, useState } from "react";
import {
  Check,
  FileUp,
  MonitorCog,
  Moon,
  Play,
  ShieldCheck,
  Sun,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
  executeScript,
  executeScriptArchive,
  isTauriRuntime,
  listScriptArchives,
  restoreScriptArchive,
  saveScriptArchive,
  setScriptArchiveEnabled,
} from "@/lib/tauri";
import type { ScriptArchiveSummary, ThemeMode } from "@/types/moseek";

interface SettingsViewProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  snifferCompanionUrl: string;
  onSnifferCompanionUrlChange: (url: string) => void;
}

export function SettingsView({
  theme,
  onThemeChange,
  snifferCompanionUrl,
  onSnifferCompanionUrlChange,
}: SettingsViewProps) {
  const [runtimeScript, setRuntimeScript] = useState(
    "function main(input) { return { title: input.title.toUpperCase(), fetchType: typeof fetch }; }",
  );
  const [runtimeInput, setRuntimeInput] = useState('{"title":"demo"}');
  const [runtimeHosts, setRuntimeHosts] = useState("");
  const [runtimeHeaders, setRuntimeHeaders] = useState("");
  const [runtimeOutput, setRuntimeOutput] = useState("");
  const [isExecutingScript, setIsExecutingScript] = useState(false);
  const [scriptArchives, setScriptArchives] = useState<ScriptArchiveSummary[]>(
    [],
  );
  const [isLoadingArchives, setIsLoadingArchives] = useState(false);
  const [archiveMessage, setArchiveMessage] = useState("");
  const [deletedArchiveId, setDeletedArchiveId] = useState<number | null>(null);
  const [archiveEntry, setArchiveEntry] = useState("main");
  const [archiveHttpHosts, setArchiveHttpHosts] = useState("");
  const [archiveHeaders, setArchiveHeaders] = useState("");
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
  }, []);

  const handleExecuteScript = async () => {
    if (isExecutingScript) return;
    setIsExecutingScript(true);
    try {
      const input = JSON.parse(runtimeInput) as unknown;
      const httpHeaders = runtimeHeaders.trim()
        ? (JSON.parse(runtimeHeaders) as Record<string, string>)
        : {};
      const result = await executeScript({
        script: runtimeScript,
        entry: "main",
        input,
        httpHosts: runtimeHosts
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
        httpHeaders,
      });
      if (!result) {
        throw new Error(
          "浏览器预览不会执行脚本运行时，请在 Tauri 桌面应用中使用。 ",
        );
      }
      setRuntimeOutput(
        JSON.stringify(
          {
            ok: true,
            value: result.value,
            adapterId: result.adapterId,
            httpCallCount: result.httpCallCount,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      setRuntimeOutput(
        JSON.stringify(
          {
            ok: false,
            error: error instanceof Error ? error.message : "脚本执行失败",
          },
          null,
          2,
        ),
      );
    } finally {
      setIsExecutingScript(false);
    }
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

  const handleExecuteScriptArchive = async (archive: ScriptArchiveSummary) => {
    if (isExecutingScript || !archive.enabled) return;
    setIsExecutingScript(true);
    try {
      const input = JSON.parse(runtimeInput) as unknown;
      const result = await executeScriptArchive(archive.id, input);
      if (!result) throw new Error("浏览器预览不会执行脚本档案。");
      setRuntimeOutput(
        JSON.stringify(
          {
            ok: true,
            archive: archive.name,
            value: result.value,
            adapterId: result.adapterId,
            httpCallCount: result.httpCallCount,
          },
          null,
          2,
        ),
      );
      const archives = await listScriptArchives();
      if (archives) setScriptArchives(archives);
    } catch (error) {
      setRuntimeOutput(
        JSON.stringify(
          {
            ok: false,
            error: error instanceof Error ? error.message : "脚本档案执行失败",
          },
          null,
          2,
        ),
      );
    } finally {
      setIsExecutingScript(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-8 py-8">
        <div>
          <p className="text-sm font-medium text-primary">系统偏好</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
            设置
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            控制主题、播放行为和本机访问边界。
          </p>
        </div>

        <Tabs defaultValue="appearance" className="flex flex-col gap-6">
          <TabsList className="w-fit">
            <TabsTrigger value="appearance">外观</TabsTrigger>
            <TabsTrigger value="player">播放器</TabsTrigger>
            <TabsTrigger value="security">安全与网络</TabsTrigger>
            <TabsTrigger value="storage">存储</TabsTrigger>
          </TabsList>

          <TabsContent
            value="appearance"
            className="grid grid-cols-[1.2fr_0.8fr] gap-6"
          >
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <MonitorCog data-icon="inline-start" aria-hidden="true" />
                  主题模式
                </CardTitle>
                <CardDescription>默认跟随 Windows 系统外观。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Select
                  value={theme}
                  onValueChange={(value) => onThemeChange(value as ThemeMode)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择主题" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="system">
                        <span className="flex items-center gap-2">
                          <MonitorCog
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          跟随系统
                        </span>
                      </SelectItem>
                      <SelectItem value="light">
                        <span className="flex items-center gap-2">
                          <Sun data-icon="inline-start" aria-hidden="true" />
                          浅色
                        </span>
                      </SelectItem>
                      <SelectItem value="dark">
                        <span className="flex items-center gap-2">
                          <Moon data-icon="inline-start" aria-hidden="true" />
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
            <Card>
              <CardHeader>
                <CardTitle className="text-base">界面状态</CardTitle>
                <CardDescription>当前工作区的显示信息</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">界面字体</span>
                  <span className="font-medium">IBM Plex Sans</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">动画时长</span>
                  <span className="font-medium">160–240ms</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">缩放比例</span>
                  <span className="font-medium">100%</span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="player" className="grid grid-cols-2 gap-6">
            <PreferenceCard
              title="播放行为"
              description="控制播放器开始播放前后的行为"
            >
              <PreferenceRow label="自动记忆播放进度" checked />
              <PreferenceRow label="默认跳过片头" />
              <PreferenceRow label="播放失败时自动切换线路" />
            </PreferenceCard>
            <PreferenceCard
              title="播放质量"
              description="播放器只会使用已解析出的安全地址"
            >
              <PreferenceRow label="优先选择高清线路" checked />
              <PreferenceRow label="允许 HTTP 播放地址" checked />
              <PreferenceRow label="使用外部播放器" />
            </PreferenceCard>
          </TabsContent>

          <TabsContent value="security" className="grid grid-cols-2 gap-6">
            <PreferenceCard
              title="本机与局域网"
              description="这些选项默认关闭，开启前会显示风险提示"
            >
              <PreferenceRow label="允许访问 127.0.0.1" />
              <PreferenceRow label="允许访问局域网地址" />
              <PreferenceRow label="允许本机服务依赖" />
            </PreferenceCard>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck data-icon="inline-start" aria-hidden="true" />
                  执行边界
                </CardTitle>
                <CardDescription>
                  导入配置不会改变这些默认规则。
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
                  日志会隐藏 token、Cookie 和密钥
                </p>
                <p className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 shrink-0 text-[color:var(--status-supported)]"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  外部播放器只在用户主动触发时打开
                </p>
              </CardContent>
            </Card>
            <PreferenceCard
              title="本地嗅探伴侣"
              description="仅连接本机回环地址，不会把嗅探请求发送到远程服务"
            >
              <Input
                value={snifferCompanionUrl}
                onChange={(event) =>
                  onSnifferCompanionUrlChange(event.target.value)
                }
                placeholder="http://127.0.0.1:57573/sniffer"
                aria-label="本地嗅探伴侣地址"
              />
            </PreferenceCard>
            <Card className="col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileUp data-icon="inline-start" aria-hidden="true" />
                  本地脚本档案
                </CardTitle>
                <CardDescription>
                  导入后默认停用；档案按 SHA-256 去重。Cookie 会保存到 Windows
                  凭据存储，不会写入
                  SQLite；删除只影响本地档案，不会修改原始配置。
                </CardDescription>
              </CardHeader>
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
                    className="gap-2"
                    onClick={() => scriptFileInputRef.current?.click()}
                    disabled={!isTauriRuntime() || isLoadingArchives}
                  >
                    <FileUp data-icon="inline-start" aria-hidden="true" />
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
                          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                            {archive.fileName} · sha256{" "}
                            {archive.sha256.slice(0, 16)}…
                            {archive.httpHeaderNames.length > 0 &&
                              ` · headers ${archive.httpHeaderNames.join(", ")}`}
                          </p>
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
                          <Play data-icon="inline-start" aria-hidden="true" />
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
                          <Trash2 data-icon="inline-start" aria-hidden="true" />
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
            </Card>
            <Card className="col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck data-icon="inline-start" aria-hidden="true" />
                  受限脚本运行时
                </CardTitle>
                <CardDescription>
                  只运行当前输入的脚本；无文件、Shell、DOM 和默认网络权限。HTTP
                  主机必须显式列入 allowlist。
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-3">
                  <Textarea
                    value={runtimeScript}
                    onChange={(event) => setRuntimeScript(event.target.value)}
                    className="min-h-36 font-mono text-xs"
                    aria-label="运行时脚本"
                  />
                  <Input
                    value={runtimeInput}
                    onChange={(event) => setRuntimeInput(event.target.value)}
                    placeholder='{"title":"demo"}'
                    aria-label="脚本 JSON 输入"
                    className="font-mono text-xs"
                  />
                  <Input
                    value={runtimeHosts}
                    onChange={(event) => setRuntimeHosts(event.target.value)}
                    placeholder="允许的 HTTP 主机，逗号分隔；留空表示禁止网络"
                    aria-label="脚本 HTTP 主机 allowlist"
                    className="font-mono text-xs"
                  />
                  <Textarea
                    value={runtimeHeaders}
                    onChange={(event) => setRuntimeHeaders(event.target.value)}
                    placeholder='请求头 JSON，例如 {"Referer":"https://example.com"}'
                    aria-label="脚本运行时请求头"
                    className="min-h-16 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    className="w-fit gap-2"
                    onClick={() => void handleExecuteScript()}
                    disabled={isExecutingScript || !isTauriRuntime()}
                  >
                    <Check data-icon="inline-start" aria-hidden="true" />
                    {isExecutingScript ? "执行中..." : "执行本地脚本"}
                  </Button>
                </div>
                <Textarea
                  value={runtimeOutput}
                  readOnly
                  className="min-h-56 font-mono text-xs"
                  placeholder="执行结果会显示在这里"
                  aria-label="脚本执行结果"
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="storage" className="grid grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">本地路径</CardTitle>
                <CardDescription>
                  缓存和下载目录将在 Rust 存储层接入后生效。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="rounded-md border bg-muted/25 p-3">
                  <p className="text-xs text-muted-foreground">缓存位置</p>
                  <p className="mt-1 font-medium">
                    %LOCALAPPDATA%\Moseek\cache
                  </p>
                </div>
                <div className="rounded-md border bg-muted/25 p-3">
                  <p className="text-xs text-muted-foreground">下载位置</p>
                  <p className="mt-1 font-medium">
                    %USERPROFILE%\Downloads\Moseek
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  数据清理
                </CardTitle>
                <CardDescription>
                  只清理本地缓存，不会删除原始配置文件。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button type="button" variant="outline">
                  清理请求缓存
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function PreferenceCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
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
}: {
  label: string;
  checked?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md px-2 py-3 hover:bg-muted/50">
      <span className="text-sm">{label}</span>
      <Switch defaultChecked={checked} aria-label={label} />
    </div>
  );
}
