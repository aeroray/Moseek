import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  AlertTriangle,
  Braces,
  Check,
  ChevronRight,
  Code2,
  Download,
  FileJson,
  FileUp,
  Filter,
  Globe2,
  Info,
  Link2,
  Layers3,
  ListFilter,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { JsonEditor } from "@/components/json-editor";
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
import {
  countParsedCapabilities,
  formatConfigText,
  parseConfigText,
  repairConfigText,
  type ParseResult,
} from "@/features/config/config-parser";
import {
  adapterRegistry,
  adapterStatusLabel,
  getAdapterProfile,
  type AdapterExecution,
} from "@/lib/adapters";
import { getCapabilityCounts } from "@/lib/capability-stats";
import { cn } from "@/lib/utils";
import {
  activateConfigDocument,
  deleteConfigDocument,
  exportConfig,
  fetchConfigUrl,
  saveConfigDocument,
  type ConfigDocumentSummary,
  type StoredConfigDocument,
} from "@/lib/tauri";
import { useAppStore } from "@/stores/app-store";
import type { CapabilityStatus, SourceRecord } from "@/types/moseek";

type SourceFilter = "all" | CapabilityStatus;
type ImportMode = "remote" | "local";

export function ConfigCenter() {
  const configDocuments = useAppStore((state) => state.configDocuments);
  const configDocumentCache = useAppStore((state) => state.configDocumentCache);
  const activeConfigId = useAppStore((state) => state.activeConfigId);
  const sources = useAppStore((state) => state.sources);
  const rawConfig = useAppStore((state) => state.rawConfig);
  const normalizedConfig = useAppStore((state) => state.normalizedConfig);
  const lastImportedAt = useAppStore((state) => state.lastImportedAt);
  const toggleSource = useAppStore((state) => state.toggleSource);
  const setConfigDocument = useAppStore((state) => state.setConfigDocument);
  const setConfigDocuments = useAppStore((state) => state.setConfigDocuments);
  const removeConfigDocument = useAppStore(
    (state) => state.removeConfigDocument,
  );
  const clearConfigDocument = useAppStore((state) => state.clearConfigDocument);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [inspectedSourceKey, setInspectedSourceKey] = useState<string | null>(
    null,
  );
  const [importOpen, setImportOpen] = useState(false);
  const [configName, setConfigName] = useState("");
  const [importText, setImportText] = useState("");
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [parseState, setParseState] = useState<{
    type: "idle" | "success" | "error";
    message: string;
    title?: string;
  }>({ type: "idle", message: "" });
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("remote");
  const [sourceInput, setSourceInput] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isFetchingRemote, setIsFetchingRemote] = useState(false);
  const [deleteCandidate, setDeleteCandidate] =
    useState<ConfigDocumentSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const counts = getCapabilityCounts(sources);
  const editorText = rawDraft ?? rawConfig;
  const report = parseResult ?? (rawConfig ? parseConfigText(rawConfig) : null);
  const inspectedSource =
    sources.find((source) => source.key === inspectedSourceKey) ?? null;
  const reportCounts = countParsedCapabilities(report?.sources ?? []);
  const adapterRows = useMemo(
    () =>
      adapterRegistry.map((adapter) => ({
        adapter,
        sources: sources.filter(
          (source) => getAdapterProfile(source).id === adapter.id,
        ),
      })),
    [sources],
  );

  useEffect(() => {
    setRawDraft(rawConfig);
    setImportText(rawConfig);
    setParseResult(rawConfig ? parseConfigText(rawConfig) : null);
  }, [activeConfigId, rawConfig]);

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

  const openImportDialog = () => {
    setConfigName(`配置 ${configDocuments.length + 1}`);
    setImportMode("remote");
    setSourceInput("");
    setSelectedFileName("");
    setImportText("");
    setParseResult(null);
    setParseState({ type: "idle", message: "" });
    setImportOpen(true);
  };

  const handleActivate = async (documentId: number) => {
    if (documentId === activeConfigId) return;
    try {
      const document =
        configDocumentCache[documentId] ??
        (await activateConfigDocument(documentId));
      if (!document) {
        setParseState({
          type: "error",
          message: "无法读取该配置，请重新导入。",
        });
        return;
      }
      setConfigDocument(document);
      setParseState({
        type: "success",
        message: `已切换到「${document.name}」。影视库和直播将使用这份配置。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "配置切换失败";
      setParseState({ type: "error", message });
    }
  };

  const handleDelete = async () => {
    if (!deleteCandidate) return;
    const documentId = deleteCandidate.id;
    setDeleteCandidate(null);
    try {
      const nextDocument = await deleteConfigDocument(documentId);
      const remainingDocuments = configDocuments.filter(
        (document) => document.id !== documentId,
      );
      removeConfigDocument(documentId);
      setConfigDocuments(remainingDocuments);
      if (nextDocument) {
        setConfigDocument(nextDocument);
        return;
      }
      if (documentId !== activeConfigId) return;
      const fallback = remainingDocuments
        .map((document) => configDocumentCache[document.id])
        .find((document): document is StoredConfigDocument =>
          Boolean(document),
        );
      if (fallback) {
        setConfigDocument(fallback);
      } else {
        clearConfigDocument();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除配置失败";
      setParseState({ type: "error", message });
    }
  };

  const handleToggleSource = async (sourceKey: string) => {
    try {
      await toggleSource(sourceKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : "源状态保存失败";
      setParseState({ type: "error", message });
    }
  };

  const handleLocalFile = async (file: File) => {
    if (!file) return;
    setImportMode("local");
    setSelectedFileName(file.name);
    setIsDraggingFile(false);
    setConfigName(file.name.replace(/\.(json5?|txt)$/i, "") || file.name);
    setImportText(await file.text());
    setParseState({
      type: "idle",
      message: "",
    });
  };

  const handleFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await handleLocalFile(file);
    event.target.value = "";
  };

  const handleFileDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingFile(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    await handleLocalFile(file);
  };

  const handleFetchRemote = async () => {
    if (!sourceInput.trim()) {
      setParseState({ type: "error", message: "请输入配置 URL。" });
      return;
    }
    setIsFetchingRemote(true);
    try {
      const text = await fetchConfigUrl(sourceInput.trim());
      if (!text) {
        setParseState({
          type: "error",
          message:
            "浏览器预览不会直接请求远程配置，请在 Tauri 桌面应用中使用此功能。",
        });
        return;
      }
      setImportText(text);
      setSelectedFileName("");
      setParseState({
        type: "success",
        message: "远程配置已载入，请点击解析配置生成报告。",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "远程配置请求失败";
      setParseState({ type: "error", message });
    } finally {
      setIsFetchingRemote(false);
    }
  };

  const handleFormatConfig = () => {
    if (!importText.trim()) return;
    const result = formatConfigText(importText);
    if (!result.ok) {
      const issue = result.issue;
      const position = issue?.line
        ? `（第 ${issue.line} 行，第 ${issue.column ?? 0} 列）`
        : "";
      setParseState({
        type: "error",
        message: `格式化失败${position}：${issue?.message ?? "未知解析错误"}`,
      });
      return;
    }
    setImportText(result.text);
    setParseState({
      type: "success",
      title: "格式化完成",
      message: "配置已按 JSON5 结构重新排版，请点击解析配置生成报告。",
    });
  };

  const handleRepairConfig = () => {
    if (!importText.trim()) return;
    const result = repairConfigText(importText);
    if (!result.ok) {
      const issue = result.issue;
      const position = issue?.line
        ? `（第 ${issue.line} 行，第 ${issue.column ?? 0} 列）`
        : "";
      setParseState({
        type: "error",
        message: `修正失败${position}：${issue?.message ?? "未找到安全的自动修正方式"}`,
      });
      return;
    }
    setImportText(result.text);
    setParseState({
      type: "success",
      title: "修正完成",
      message: `${result.changes.join("、")}。请点击解析配置生成报告。`,
    });
  };

  const handleParse = async () => {
    setIsParsing(true);
    const result = parseConfigText(importText);
    setParseResult(result);

    if (!result.ok) {
      const issue = result.issues[0];
      const position = issue?.line
        ? `（第 ${issue.line} 行，第 ${issue.column ?? 0} 列）`
        : "";
      setParseState({
        type: "error",
        message: `解析失败${position}：${issue?.message ?? "未知解析错误"}`,
      });
      setIsParsing(false);
      return;
    }

    const parsedCounts = countParsedCapabilities(result.sources);
    const name = configName.trim() || `配置 ${configDocuments.length + 1}`;

    try {
      const savedDocument = await saveConfigDocument({
        name,
        rawConfig: importText,
        normalizedConfig: result.normalizedConfig,
        sources: result.sources,
        liveCount: result.liveCount,
      });
      const document: StoredConfigDocument = savedDocument ?? {
        id: -Date.now(),
        name,
        rawConfig: importText,
        normalizedConfig: result.normalizedConfig,
        sources: result.sources,
        sourceCount: result.sources.length,
        liveCount: result.liveCount,
        importedAt: new Date().toISOString(),
      };
      setConfigDocument(document);
      setParseState({
        type: "success",
        message: `解析完成：${result.sources.length} 个影视源、${result.liveCount} 个直播源；可用 ${parsedCounts.supported} 个，${result.issues.length} 个需要关注。`,
      });
      setImportOpen(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "本地数据库写入失败";
      setParseState({
        type: "error",
        message: `解析成功，但保存失败：${message}`,
      });
    } finally {
      setIsParsing(false);
    }
  };

  const handleExport = async () => {
    let persistedConfig: string | null = null;
    try {
      persistedConfig = await exportConfig(activeConfigId ?? undefined);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "本地配置导出失败";
      setParseState({ type: "error", message });
    }
    const exportText =
      persistedConfig ??
      (normalizedConfig ||
        JSON.stringify({ sites: sources, lives: [] }, null, 2));
    const blob = new Blob([exportText], { type: "application/json" });
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
                Phase 5
              </Badge>
              <span className="text-xs text-muted-foreground">
                适配器、安全边界
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
            <Button type="button" className="gap-2" onClick={openImportDialog}>
              <Upload data-icon="inline-start" aria-hidden="true" />
              导入配置
            </Button>
          </div>
        </section>

        <Card>
          <CardHeader className="border-b pb-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Layers3 data-icon="inline-start" aria-hidden="true" />
                  配置档
                </CardTitle>
                <CardDescription>
                  每份配置独立保存。影视库、直播和源启停只作用于当前配置。
                </CardDescription>
              </div>
              <Badge variant="secondary">{configDocuments.length} 份</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {configDocuments.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">配置名称</TableHead>
                    <TableHead>内容</TableHead>
                    <TableHead>导入时间</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="pr-6 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {configDocuments.map((document) => {
                    const isActive = document.id === activeConfigId;
                    return (
                      <TableRow key={document.id}>
                        <TableCell className="pl-6">
                          <div className="min-w-0">
                            <p className="font-medium">{document.name}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              配置 #{document.id}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {document.sourceCount} 个源 · {document.liveCount}{" "}
                          个直播源
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatImportTime(document.importedAt)}
                        </TableCell>
                        <TableCell>
                          {isActive ? (
                            <Badge variant="secondary">当前使用</Badge>
                          ) : (
                            <Badge variant="outline">已保存</Badge>
                          )}
                        </TableCell>
                        <TableCell className="pr-6 text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant={isActive ? "secondary" : "outline"}
                              size="sm"
                              disabled={isActive}
                              onClick={() => void handleActivate(document.id)}
                            >
                              {isActive ? "使用中" : "使用"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`删除配置 ${document.name}`}
                              onClick={() => setDeleteCandidate(document)}
                            >
                              <Trash2
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <Empty className="min-h-56">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Layers3 data-icon="inline-start" aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>还没有配置档</EmptyTitle>
                  <EmptyDescription>
                    导入第一份配置后，它会作为当前工作区保存；后续配置可以随时切换。
                  </EmptyDescription>
                </EmptyHeader>
                <Button type="button" onClick={openImportDialog}>
                  导入第一份配置
                </Button>
              </Empty>
            )}
          </CardContent>
        </Card>

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
              <TabsTrigger value="adapters" className="gap-2">
                <Link2 data-icon="inline-start" aria-hidden="true" />
                适配器矩阵
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
              {lastImportedAt
                ? `最后解析：${formatImportTime(lastImportedAt)}`
                : "尚未导入配置"}
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
                            onClick={() => setInspectedSourceKey(source.key)}
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
                                onCheckedChange={() =>
                                  void handleToggleSource(source.key)
                                }
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

          <TabsContent value="adapters">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Link2 data-icon="inline-start" aria-hidden="true" />
                  适配器能力矩阵
                </CardTitle>
                <CardDescription>
                  只有内置 CMS
                  和直播适配器会执行网络请求，其余扩展只做识别和诊断。
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-6">适配器</TableHead>
                      <TableHead>执行状态</TableHead>
                      <TableHead>支持操作</TableHead>
                      <TableHead>当前源</TableHead>
                      <TableHead className="pr-6">边界说明</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {adapterRows.map(({ adapter, sources: matchedSources }) => (
                      <TableRow key={adapter.id}>
                        <TableCell className="pl-6">
                          <div>
                            <p className="font-medium">{adapter.label}</p>
                            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                              {adapter.id}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <AdapterStatusBadge execution={adapter.execution} />
                        </TableCell>
                        <TableCell>
                          {adapter.operations.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {adapter.operations.map((operation) => (
                                <Badge
                                  key={operation}
                                  variant="secondary"
                                  className="text-[10px]"
                                >
                                  {operation}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              无执行操作
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {matchedSources.length > 0
                            ? `${matchedSources.length} 个`
                            : "未使用"}
                        </TableCell>
                        <TableCell className="max-w-[360px] pr-6 text-sm text-muted-foreground">
                          {adapter.reason}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
                  可直接编辑原始配置；确认后使用导入流程解析并保存。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <JsonEditor
                  value={editorText}
                  onChange={(value) => {
                    setRawDraft(value);
                    setImportText(value);
                  }}
                  aria-label="原始配置文本"
                  className="h-[min(680px,calc(100vh-12rem))] min-h-[520px] w-full"
                />
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
              <CardContent className={report ? "grid grid-cols-2 gap-4" : ""}>
                {report ? (
                  <>
                    <ReportLine
                      title="结构解析"
                      detail={
                        report.ok
                          ? "JSON5 兼容，允许注释和尾逗号"
                          : (report.issues[0]?.message ?? "配置结构无法解析")
                      }
                      status={report.ok ? "通过" : "失败"}
                      danger={!report.ok}
                    />
                    <ReportLine
                      title="普通 CMS"
                      detail={`${reportCounts.supported} 个源可以直接进入搜索与详情流程`}
                      status="通过"
                    />
                    <ReportLine
                      title="远程依赖"
                      detail={`${reportCounts.partial} 个源含 JAR 字段，已标记为部分支持`}
                      status="已隔离"
                      warning
                    />
                    <ReportLine
                      title="私有协议"
                      detail={`${reportCounts["needs-adapter"]} 个源需要 adapter，当前不执行`}
                      status="待适配"
                      warning
                    />
                    <ReportLine
                      title="危险执行路径"
                      detail={`${reportCounts.blocked} 个远程脚本或扩展被默认阻止`}
                      status="已阻止"
                      danger
                    />
                    <ReportLine
                      title="字段校验"
                      detail={`${report.issues.length} 个字段或能力问题已记录，可在源详情中查看原因`}
                      status={report.issues.length > 0 ? "需关注" : "通过"}
                      warning={report.issues.length > 0}
                    />
                    {report.issues.length > 0 && (
                      <div className="col-span-2 rounded-md border bg-muted/20 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                          诊断明细
                        </p>
                        <div className="mt-3 flex flex-col gap-2">
                          {report.issues.slice(0, 5).map((issue) => (
                            <p
                              key={`${issue.path}-${issue.message}`}
                              className="text-sm text-muted-foreground"
                            >
                              <span className="font-mono text-xs text-foreground">
                                {issue.path}
                              </span>
                              {issue.line
                                ? ` · 第 ${issue.line} 行，第 ${issue.column ?? 0} 列`
                                : ""}
                              {` · ${issue.message}`}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <Empty className="min-h-64 border border-dashed bg-card/40">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <FileJson data-icon="inline-start" aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>还没有解析报告</EmptyTitle>
                      <EmptyDescription>
                        导入并解析配置后，这里会显示结构、能力和安全边界报告。
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="flex h-[min(46rem,calc(100vh-2rem))] max-h-[calc(100vh-2rem)] max-w-4xl flex-col overflow-hidden sm:max-w-4xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>导入配置</DialogTitle>
            <DialogDescription>
              选择本地文件、获取远程
              URL，或直接粘贴配置文本。当前只解析和分类，不执行远程依赖。
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
            <Input
              value={configName}
              onChange={(event) => setConfigName(event.target.value)}
              placeholder="例如：主用影视源、备用直播源"
              aria-label="配置名称"
            />
            <div className="grid grid-cols-2 gap-1 rounded-md bg-muted/50 p-1">
              <Button
                type="button"
                variant={importMode === "remote" ? "secondary" : "ghost"}
                className="gap-2"
                onClick={() => {
                  setImportMode("remote");
                  setIsDraggingFile(false);
                  setParseState({ type: "idle", message: "" });
                }}
              >
                <Globe2 data-icon="inline-start" aria-hidden="true" />
                远程 URL
              </Button>
              <Button
                type="button"
                variant={importMode === "local" ? "secondary" : "ghost"}
                className="gap-2"
                onClick={() => {
                  setImportMode("local");
                  setIsDraggingFile(false);
                  setParseState({ type: "idle", message: "" });
                }}
              >
                <FileUp data-icon="inline-start" aria-hidden="true" />
                本地文件
              </Button>
            </div>
            {importMode === "remote" ? (
              <div className="flex h-20 shrink-0 items-center gap-2 rounded-md border bg-muted/20 p-3">
                <Input
                  type="url"
                  value={sourceInput}
                  onChange={(event) => setSourceInput(event.target.value)}
                  placeholder="https://example.com/config.json5"
                  aria-label="远程配置 URL"
                  className="min-w-0 flex-1 bg-background"
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="shrink-0 gap-2"
                  onClick={handleFetchRemote}
                  disabled={isFetchingRemote || !sourceInput.trim()}
                >
                  <Globe2 data-icon="inline-start" aria-hidden="true" />
                  {isFetchingRemote ? "请求中..." : "获取配置"}
                </Button>
              </div>
            ) : (
              <div
                className={cn(
                  "flex h-20 shrink-0 items-center justify-between gap-4 rounded-md border border-dashed bg-muted/20 p-4 transition-colors",
                  isDraggingFile && "border-primary bg-accent/40",
                )}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                  setIsDraggingFile(true);
                }}
                onDragLeave={() => setIsDraggingFile(false)}
                onDrop={handleFileDrop}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                    <FileUp data-icon="inline-start" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {selectedFileName || "拖拽 JSON / JSON5 文件到这里"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {selectedFileName
                        ? "文件内容已载入编辑区"
                        : "也可以点击右侧选择文件"}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 gap-2"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUp data-icon="inline-start" aria-hidden="true" />
                  选择文件
                </Button>
              </div>
            )}
            <p className="-mt-2 shrink-0 text-xs text-muted-foreground">
              {importMode === "remote"
                ? "远程请求由 Rust 请求层执行。"
                : "支持拖入或选择本地 JSON / JSON5 文件，内容会自动载入。"}
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.json5,application/json"
              className="hidden"
              onChange={handleFilePick}
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-3 rounded-t-md border border-b-0 bg-muted/20 px-3 py-2">
                <span className="text-xs font-medium text-muted-foreground">
                  JSON 配置
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-2"
                    onClick={handleFormatConfig}
                    disabled={!importText.trim()}
                  >
                    <Braces data-icon="inline-start" aria-hidden="true" />
                    格式化
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-2"
                    onClick={handleRepairConfig}
                    disabled={!importText.trim()}
                  >
                    <WandSparkles data-icon="inline-start" aria-hidden="true" />
                    修正配置
                  </Button>
                </div>
              </div>
              <JsonEditor
                value={importText}
                onChange={setImportText}
                className="min-h-0 min-w-0 flex-1 w-full rounded-t-none border-t-0"
                aria-label="配置文本"
              />
            </div>
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
                  {parseState.type === "success"
                    ? (parseState.title ?? "解析完成")
                    : "需要修正配置"}
                </AlertTitle>
                <AlertDescription>{parseState.message}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setImportOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              className="gap-2"
              onClick={handleParse}
              disabled={isParsing || !importText.trim()}
            >
              <FileJson data-icon="inline-start" aria-hidden="true" />
              {isParsing ? "解析中..." : "解析配置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteCandidate)}
        onOpenChange={(open) => {
          if (!open) setDeleteCandidate(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除配置档？</DialogTitle>
            <DialogDescription>
              将删除「{deleteCandidate?.name}」及其本地源快照，不能撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteCandidate(null)}
            >
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={handleDelete}>
              删除配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet
        open={Boolean(inspectedSource)}
        onOpenChange={(open) => {
          if (!open) setInspectedSourceKey(null);
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
                  <AdapterDetail source={inspectedSource} />
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
                    onClick={() => void handleToggleSource(inspectedSource.key)}
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

function AdapterStatusBadge({ execution }: { execution: AdapterExecution }) {
  const toneClass = {
    enabled:
      "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
    partial:
      "border-[color:var(--status-partial-border)] bg-[color:var(--status-partial-bg)] text-[color:var(--status-partial)]",
    "needs-adapter":
      "border-[color:var(--status-adapter-border)] bg-[color:var(--status-adapter-bg)] text-[color:var(--status-adapter)]",
    blocked:
      "border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)] text-[color:var(--status-blocked)]",
  }[execution];
  return (
    <Badge variant="outline" className={toneClass}>
      {adapterStatusLabel(execution)}
    </Badge>
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

function AdapterDetail({ source }: { source: SourceRecord }) {
  const adapter = getAdapterProfile(source);
  return (
    <DetailSection title="适配器边界">
      <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
        <div>
          <p className="font-medium">{adapter.label}</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {adapter.id}
          </p>
        </div>
        <AdapterStatusBadge execution={adapter.execution} />
      </div>
      <div className="rounded-md border bg-muted/20 p-3 text-sm leading-6 text-muted-foreground">
        {adapter.reason}
      </div>
      {adapter.operations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {adapter.operations.map((operation) => (
            <Badge key={operation} variant="secondary" className="text-[10px]">
              {operation}
            </Badge>
          ))}
        </div>
      )}
    </DetailSection>
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

function formatImportTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
