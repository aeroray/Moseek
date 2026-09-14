import { useMemo, useRef, useState, type ChangeEvent } from "react";
import JSON5 from "json5";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ClipboardPaste,
  Code2,
  Download,
  FileJson,
  FileUp,
  Filter,
  Globe2,
  Info,
  Link2,
  ListFilter,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getCapabilityCounts } from "@/lib/mock-data";
import { useAppStore } from "@/stores/app-store";
import type { CapabilityStatus, SourceRecord } from "@/types/moseek";

const defaultConfigText = `{
  // Moseek 保留原始文本，不会自动篡改导入内容
  "sites": [
    { "key": "clzy", "name": "初恋资源", "type": 1, "api": "https://..." },
    { "key": "xiaohu", "name": "小胡", "type": 3, "api": "https://...", "jar": "https://..." }
  ],
  "lives": []
}`;

type SourceFilter = "all" | CapabilityStatus;

export function ConfigCenter() {
  const sources = useAppStore((state) => state.sources);
  const toggleSource = useAppStore((state) => state.toggleSource);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [inspectedSource, setInspectedSource] = useState<SourceRecord | null>(
    null,
  );
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState(defaultConfigText);
  const [parseState, setParseState] = useState<{
    type: "idle" | "success" | "error";
    message: string;
  }>({ type: "idle", message: "" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const counts = getCapabilityCounts(sources);

  const filteredSources = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return sources.filter((source) => {
      const matchesFilter =
        sourceFilter === "all" || source.capability === sourceFilter;
      const matchesQuery =
        !normalizedQuery ||
        [source.name, source.key, source.api].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        );
      return matchesFilter && matchesQuery;
    });
  }, [query, sourceFilter, sources]);

  const handleFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportText(await file.text());
    setParseState({
      type: "idle",
      message: `已载入 ${file.name}，点击解析以生成报告。`,
    });
  };

  const handleParse = () => {
    try {
      const parsed: unknown = JSON5.parse(importText);
      const record =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : {};
      const siteCount = Array.isArray(record.sites) ? record.sites.length : 0;
      const liveCount = Array.isArray(record.lives) ? record.lives.length : 0;
      setParseState({
        type: "success",
        message: `解析成功：识别到 ${siteCount} 个影视源、${liveCount} 个直播源。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知解析错误";
      setParseState({ type: "error", message: `解析失败：${message}` });
    }
  };

  const handleExport = () => {
    const blob = new Blob(
      [JSON.stringify({ sites: sources, lives: [] }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "moseek-normalized-config.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-[1520px] flex-col gap-6 px-8 py-8">
        <section className="flex items-end justify-between gap-8">
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Badge
                variant="secondary"
                className="gap-1.5 bg-accent text-accent-foreground"
              >
                <SlidersHorizontal
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                Phase 2
              </Badge>
              <span className="text-xs text-muted-foreground">
                导入、分类、审查
              </span>
            </div>
            <h1 className="font-display text-3xl font-semibold tracking-tight">
              配置中心
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              这里是 Moseek
              的安全边界。原始配置、标准化数据和每个源的能力状态分开保存，任何被阻止的依赖都会明确说明原因。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={handleExport}
            >
              <Download data-icon="inline-start" aria-hidden="true" />
              导出标准配置
            </Button>
            <Button
              type="button"
              className="gap-2"
              onClick={() => setImportOpen(true)}
            >
              <Upload data-icon="inline-start" aria-hidden="true" />
              导入配置
            </Button>
          </div>
        </section>

        <Alert className="border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)] text-[color:var(--status-blocked)]">
          <ShieldAlert data-icon="inline-start" aria-hidden="true" />
          <AlertTitle>远程代码默认不执行</AlertTitle>
          <AlertDescription className="text-[color:var(--status-blocked)]/80">
            远程 JAR、spider、Drpy JS、CSP 扩展和 proxy://
            私有协议会被识别并分类，但不会被静默运行。
          </AlertDescription>
        </Alert>

        <section className="grid grid-cols-5 gap-3" aria-label="配置解析报告">
          <ReportCard label="已识别源" value={sources.length} icon={FileJson} />
          <ReportCard
            label="普通可用"
            value={counts.supported}
            icon={Check}
            tone="supported"
          />
          <ReportCard
            label="部分支持"
            value={counts.partial}
            icon={Info}
            tone="partial"
          />
          <ReportCard
            label="需适配"
            value={counts["needs-adapter"]}
            icon={Link2}
            tone="adapter"
          />
          <ReportCard
            label="已阻止"
            value={counts.blocked + counts.invalid}
            icon={ShieldAlert}
            tone="blocked"
          />
        </section>

        <Tabs defaultValue="sources" className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-4">
            <TabsList>
              <TabsTrigger value="sources" className="gap-2">
                <ListFilter data-icon="inline-start" aria-hidden="true" />
                资源源
              </TabsTrigger>
              <TabsTrigger value="raw" className="gap-2">
                <Code2 data-icon="inline-start" aria-hidden="true" />
                原始配置
              </TabsTrigger>
              <TabsTrigger value="report" className="gap-2">
                <FileJson data-icon="inline-start" aria-hidden="true" />
                解析报告
              </TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-2 rounded-full bg-[color:var(--status-supported)]" />
              最后解析：今天 09:42
            </div>
          </div>

          <TabsContent value="sources" className="flex flex-col gap-4">
            <Card>
              <CardHeader className="border-b pb-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <CardTitle className="text-base">源能力清单</CardTitle>
                    <CardDescription>
                      点击任意一行查看标准化字段、依赖地址和执行边界。
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative w-64">
                      <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="搜索源名称、key 或 API"
                        className="pl-9"
                      />
                    </div>
                    <Select
                      value={sourceFilter}
                      onValueChange={(value) =>
                        setSourceFilter(value as SourceFilter)
                      }
                    >
                      <SelectTrigger className="w-40">
                        <Filter data-icon="inline-start" aria-hidden="true" />
                        <SelectValue placeholder="筛选状态" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部状态</SelectItem>
                          <SelectItem value="supported">可用</SelectItem>
                          <SelectItem value="partial">部分支持</SelectItem>
                          <SelectItem value="needs-adapter">
                            需要适配
                          </SelectItem>
                          <SelectItem value="blocked">已阻止</SelectItem>
                          <SelectItem value="invalid">配置无效</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {filteredSources.length > 0 ? (
                  <ScrollArea className="h-[440px]">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-[30%] pl-6">资源源</TableHead>
                          <TableHead>能力</TableHead>
                          <TableHead>支持范围</TableHead>
                          <TableHead>最近检查</TableHead>
                          <TableHead className="text-right">启用</TableHead>
                          <TableHead className="w-10" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredSources.map((source) => (
                          <TableRow
                            key={source.key}
                            className="cursor-pointer"
                            onClick={() => setInspectedSource(source)}
                          >
                            <TableCell className="pl-6">
                              <div className="flex items-center gap-3">
                                <div className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                  {source.sourceType === "live" ? (
                                    <Globe2
                                      data-icon="inline-start"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <FileJson
                                      data-icon="inline-start"
                                      aria-hidden="true"
                                    />
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <p className="font-medium">{source.name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {source.key} ·{" "}
                                    {source.sourceType === "cms"
                                      ? "普通 CMS"
                                      : source.sourceType === "live"
                                        ? "直播源"
                                        : "解析服务"}
                                  </p>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <CapabilityBadge status={source.capability} />
                            </TableCell>
                            <TableCell className="max-w-80">
                              <p className="truncate text-sm text-muted-foreground">
                                {source.capabilityNote}
                              </p>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {source.lastCheckedAt}
                            </TableCell>
                            <TableCell
                              className="text-right"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Switch
                                checked={source.enabled}
                                onCheckedChange={() => toggleSource(source.key)}
                                aria-label={`启用 ${source.name}`}
                              />
                            </TableCell>
                            <TableCell>
                              <ChevronRight
                                className="text-muted-foreground"
                                data-icon="inline-end"
                                aria-hidden="true"
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <ScrollBar />
                  </ScrollArea>
                ) : (
                  <Empty className="min-h-80">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Search data-icon="inline-start" aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>没有匹配的资源源</EmptyTitle>
                      <EmptyDescription>
                        调整关键词或清除状态筛选后重试。
                      </EmptyDescription>
                    </EmptyHeader>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setQuery("");
                        setSourceFilter("all");
                      }}
                    >
                      <X data-icon="inline-start" aria-hidden="true" />
                      清除筛选
                    </Button>
                  </Empty>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="raw">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Code2 data-icon="inline-start" aria-hidden="true" />
                  原始配置文本
                </CardTitle>
                <CardDescription>
                  只读预览。Moseek 会保留原文，解析失败时不会自动改写。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="max-h-[520px] overflow-auto rounded-md border bg-muted/30 p-5 font-mono text-xs leading-6 text-muted-foreground">
                  {defaultConfigText}
                </pre>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="report">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileJson data-icon="inline-start" aria-hidden="true" />
                  解析报告
                </CardTitle>
                <CardDescription>
                  按字段和执行边界整理的导入结果。
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4">
                <ReportLine
                  title="结构解析"
                  detail="JSON5 兼容，允许注释和尾逗号"
                  status="通过"
                />
                <ReportLine
                  title="普通 CMS"
                  detail={`${counts.supported} 个源可以直接进入搜索与详情流程`}
                  status="通过"
                />
                <ReportLine
                  title="远程依赖"
                  detail={`${counts.partial} 个源含 JAR 字段，已标记为部分支持`}
                  status="已隔离"
                  warning
                />
                <ReportLine
                  title="私有协议"
                  detail={`${counts["needs-adapter"]} 个源需要 adapter，当前不执行`}
                  status="待适配"
                  warning
                />
                <ReportLine
                  title="危险执行路径"
                  detail={`${counts.blocked} 个远程脚本或扩展被默认阻止`}
                  status="已阻止"
                  danger
                />
                <ReportLine
                  title="本机地址"
                  detail="当前工作区未授权 localhost 或局域网访问"
                  status="未授权"
                  warning
                />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>导入配置</DialogTitle>
            <DialogDescription>
              支持本地文件、远程 URL
              和粘贴配置文本。当前只解析和分类，不执行远程依赖。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 p-4"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp data-icon="inline-start" aria-hidden="true" />
                <span className="flex flex-col items-start gap-1">
                  <span className="font-medium">本地文件</span>
                  <span className="text-xs text-muted-foreground">
                    JSON / JSON5
                  </span>
                </span>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 p-4"
                onClick={() =>
                  setParseState({
                    type: "idle",
                    message:
                      "远程 URL 将通过 Rust 网络层请求，当前仅保留入口。",
                  })
                }
              >
                <Globe2 data-icon="inline-start" aria-hidden="true" />
                <span className="flex flex-col items-start gap-1">
                  <span className="font-medium">远程 URL</span>
                  <span className="text-xs text-muted-foreground">
                    Rust 请求层
                  </span>
                </span>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 p-4"
                onClick={() => setImportText(defaultConfigText)}
              >
                <ClipboardPaste data-icon="inline-start" aria-hidden="true" />
                <span className="flex flex-col items-start gap-1">
                  <span className="font-medium">示例文本</span>
                  <span className="text-xs text-muted-foreground">
                    载入演示配置
                  </span>
                </span>
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.json5,application/json"
              className="hidden"
              onChange={handleFilePick}
            />
            <Textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              className="min-h-64 resize-none font-mono text-xs leading-5"
              aria-label="配置文本"
            />
            {parseState.type !== "idle" && (
              <Alert
                variant={
                  parseState.type === "error" ? "destructive" : "default"
                }
              >
                {parseState.type === "success" ? (
                  <Check data-icon="inline-start" aria-hidden="true" />
                ) : (
                  <AlertTriangle data-icon="inline-start" aria-hidden="true" />
                )}
                <AlertTitle>
                  {parseState.type === "success" ? "解析完成" : "需要修正配置"}
                </AlertTitle>
                <AlertDescription>{parseState.message}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setImportOpen(false)}
            >
              取消
            </Button>
            <Button type="button" className="gap-2" onClick={handleParse}>
              <FileJson data-icon="inline-start" aria-hidden="true" />
              解析配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet
        open={Boolean(inspectedSource)}
        onOpenChange={(open) => {
          if (!open) setInspectedSource(null);
        }}
      >
        <SheetContent className="w-[480px] sm:max-w-[480px]">
          {inspectedSource && (
            <>
              <SheetHeader>
                <div className="flex items-center gap-2">
                  <CapabilityBadge status={inspectedSource.capability} />
                  <Badge variant="outline">
                    {inspectedSource.sourceType === "cms"
                      ? "普通 CMS"
                      : inspectedSource.sourceType === "live"
                        ? "直播源"
                        : "解析服务"}
                  </Badge>
                </div>
                <SheetTitle className="mt-3">{inspectedSource.name}</SheetTitle>
                <SheetDescription>
                  {inspectedSource.capabilityNote}
                </SheetDescription>
              </SheetHeader>
              <ScrollArea className="flex-1 pr-4">
                <div className="flex flex-col gap-6 py-6">
                  <DetailSection title="标准化字段">
                    <DetailRow label="key" value={inspectedSource.key} mono />
                    <DetailRow
                      label="sourceType"
                      value={inspectedSource.sourceType}
                      mono
                    />
                    <DetailRow
                      label="searchable"
                      value={inspectedSource.searchable ? "true" : "false"}
                      mono
                    />
                    <DetailRow
                      label="filterable"
                      value={inspectedSource.filterable ? "true" : "false"}
                      mono
                    />
                    <DetailRow
                      label="requestCount"
                      value={String(inspectedSource.requestCount)}
                      mono
                    />
                  </DetailSection>
                  <DetailSection title="远程地址">
                    <DetailRow label="api" value={inspectedSource.api} mono />
                    {inspectedSource.ext && (
                      <DetailRow label="ext" value={inspectedSource.ext} mono />
                    )}
                    {inspectedSource.jar && (
                      <DetailRow
                        label="jar"
                        value={inspectedSource.jar}
                        mono
                        danger
                      />
                    )}
                  </DetailSection>
                  <DetailSection title="执行说明">
                    <div className="rounded-md border bg-muted/30 p-3 text-sm leading-6 text-muted-foreground">
                      {inspectedSource.capabilityNote}
                    </div>
                    {inspectedSource.jar && (
                      <div className="mt-3 flex items-start gap-2 rounded-md border border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)] p-3 text-xs leading-5 text-[color:var(--status-blocked)]">
                        <ShieldAlert
                          className="mt-0.5 shrink-0"
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        远程 JAR 已记录但不会下载或执行。
                      </div>
                    )}
                  </DetailSection>
                </div>
                <ScrollBar />
              </ScrollArea>
              <SheetFooter className="border-t pt-4">
                <div className="flex w-full items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        inspectedSource.enabled
                          ? "bg-[color:var(--status-supported)]"
                          : "bg-muted-foreground",
                      )}
                    />
                    {inspectedSource.enabled ? "源已启用" : "源已停用"}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => toggleSource(inspectedSource.key)}
                  >
                    {inspectedSource.enabled ? "停用资源源" : "启用资源源"}
                  </Button>
                </div>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ReportCard({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number;
  icon: typeof Check;
  tone?: "default" | "supported" | "partial" | "adapter" | "blocked";
}) {
  const toneClasses = {
    default: "bg-muted text-muted-foreground",
    supported:
      "bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
    partial:
      "bg-[color:var(--status-partial-bg)] text-[color:var(--status-partial)]",
    adapter:
      "bg-[color:var(--status-adapter-bg)] text-[color:var(--status-adapter)]",
    blocked:
      "bg-[color:var(--status-blocked-bg)] text-[color:var(--status-blocked)]",
  };
  return (
    <Card className="border-border/80 shadow-none">
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-md ${toneClasses[tone]}`}
        >
          <Icon data-icon="inline-start" aria-hidden="true" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 font-display text-2xl font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
  danger = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border bg-muted/20 p-3">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "max-w-[290px] break-all text-right text-sm",
          mono && "font-mono text-xs",
          danger && "text-[color:var(--status-blocked)]",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function ReportLine({
  title,
  detail,
  status,
  warning = false,
  danger = false,
}: {
  title: string;
  detail: string;
  status: string;
  warning?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border p-4">
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          danger
            ? "bg-[color:var(--status-blocked-bg)] text-[color:var(--status-blocked)]"
            : warning
              ? "bg-[color:var(--status-partial-bg)] text-[color:var(--status-partial)]"
              : "bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
        )}
      >
        {danger ? (
          <ShieldAlert data-icon="inline-start" aria-hidden="true" />
        ) : warning ? (
          <Info data-icon="inline-start" aria-hidden="true" />
        ) : (
          <Check data-icon="inline-start" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="font-medium">{title}</p>
          <Badge
            variant="outline"
            className={cn(
              danger && "text-[color:var(--status-blocked)]",
              warning && "text-[color:var(--status-partial)]",
            )}
          >
            {status}
          </Badge>
        </div>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
