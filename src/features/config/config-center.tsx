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
  Code2,
  CircleCheck,
  CircleX,
  Download,
  FileJson,
  FileUp,
  FlaskConical,
  Filter,
  Globe2,
  Info,
  Link2,
  Layers3,
  ListFilter,
  LoaderCircle,
  Search,
  ShieldAlert,
  TestTube2,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { useToast } from "@/components/toast-host";
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
  shouldResetDrafts,
  type DraftSource,
} from "@/features/config/config-drafts";
import { describeDuplicateMatch } from "@/features/config/config-duplicate";
import {
  adapterRegistry,
  adapterStatusLabel,
  getAdapterProfile,
  isTestableSource,
  type AdapterExecution,
} from "@/lib/adapters";
import { cn } from "@/lib/utils";
import {
  activateConfigDocument,
  deleteConfigDocument,
  exportConfig,
  fetchConfigUrl,
  findConfigDuplicate,
  isTauriRuntime,
  loadActiveConfig,
  listScriptArchives,
  recoverKnownLiveSources,
  saveConfigDocument,
  setConfigSourceBaseUrl,
  setSourceScriptArchive,
  testSource,
  updateSourceTest,
  type ConfigDocumentSummary,
  type ConfigDuplicateMatch,
  type StoredConfigDocument,
} from "@/lib/tauri";
import { useAppStore } from "@/stores/app-store";
import type {
  CapabilityStatus,
  SourceOperationStatus,
  ScriptArchiveSummary,
  SourceRecord,
  SourceTestResult,
  SourceTestStatus,
} from "@/types/moseek";

/**
 * The list groups sources by whether an adapter exists for them.
 *
 * The words are 已适配 / 未适配 rather than 可用 / 不可用 because the list cannot promise a
 * source works: a source with an adapter may still fail its test, and "可用" claimed otherwise.
 * Whether a particular source actually works is what the 状态 column reports, and what the test
 * run is for. 全部 exists so the unadapted ones can be found and pruned.
 */
type SourceFilter = "available" | "unusable" | "all";
type AdapterFilter = "all" | AdapterExecution;
type ImportMode = "remote" | "local";

/**
 * How many sources a batch test probes at once.
 *
 * Serial testing made a large configuration take the sum of every source's latency. Testing all
 * of them at once would open as many sockets as there are sources, which trips rate limits and
 * makes every failure look like a local network problem. Four is enough to hide a slow source
 * behind three others without looking like a flood.
 */
const TEST_CONCURRENCY = 4;

function matchesSourceFilter(
  capability: CapabilityStatus,
  filter: SourceFilter,
) {
  if (filter === "all") return true;
  const usable = capability === "supported" || capability === "partial";
  return filter === "available" ? usable : !usable;
}

export function ConfigCenter() {
  const toast = useToast();
  const configDocuments = useAppStore((state) => state.configDocuments);
  const configDocumentCache = useAppStore((state) => state.configDocumentCache);
  const activeConfigId = useAppStore((state) => state.activeConfigId);
  const sources = useAppStore((state) => state.sources);
  const rawConfig = useAppStore((state) => state.rawConfig);
  const normalizedConfig = useAppStore((state) => state.normalizedConfig);
  const lastImportedAt = useAppStore((state) => state.lastImportedAt);
  const toggleSource = useAppStore((state) => state.toggleSource);
  const removeSources = useAppStore((state) => state.removeSources);
  const setConfigDocument = useAppStore((state) => state.setConfigDocument);
  const setSourceTestResult = useAppStore((state) => state.setSourceTestResult);
  const setConfigDocuments = useAppStore((state) => state.setConfigDocuments);
  const removeConfigDocument = useAppStore(
    (state) => state.removeConfigDocument,
  );
  const clearConfigDocument = useAppStore((state) => state.clearConfigDocument);
  const [query, setQuery] = useState("");
  /**
   * Defaults to 可用. A configuration usually carries far more sources than a user can act on,
   * and the ones that cannot run are not what they came to look at — they are what they may
   * later want to prune. Starting on 全部 made the page open on a wall of unusable rows.
   */
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("available");
  const [adapterFilter, setAdapterFilter] = useState<AdapterFilter>("all");
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
  const [configBaseUrl, setConfigBaseUrl] = useState<string | undefined>();
  const [sourceBaseUrlDraft, setSourceBaseUrlDraft] = useState("");
  const [isApplyingBaseUrl, setIsApplyingBaseUrl] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [duplicateMatch, setDuplicateMatch] =
    useState<ConfigDuplicateMatch | null>(null);
  const draftSourceRef = useRef<DraftSource>({
    documentId: null,
    rawConfig: "",
  });
  const [isFetchingRemote, setIsFetchingRemote] = useState(false);
  const [testingKeys, setTestingKeys] = useState<Set<string>>(new Set());
  /**
   * Set while a batch test is running, so the batch can be stopped and so individual rows know
   * not to offer their own start button. Cancelling only stops us from starting the next batch
   * of work: the requests already in flight cannot be recalled, but they are bounded by the
   * backend's own timeout, and their results are discarded once cancelled.
   */
  const [isBatchTesting, setIsBatchTesting] = useState(false);
  const cancelTestRef = useRef(false);
  /**
   * Releases the running batch when the user cancels. Held in a ref so the row-level cancel
   * buttons and the toolbar button all reach the same in-flight run.
   */
  const cancelRunRef = useRef<(() => void) | null>(null);
  const [scriptArchives, setScriptArchives] = useState<ScriptArchiveSummary[]>(
    [],
  );
  const [deleteCandidate, setDeleteCandidate] =
    useState<ConfigDocumentSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const liveRecoveryAttempts = useRef(new Set<number>());
  const editorText = rawDraft ?? rawConfig;
  const report =
    parseResult ??
    (rawConfig ? parseConfigText(rawConfig, configBaseUrl) : null);
  const activeDocument =
    activeConfigId === null ? undefined : configDocumentCache[activeConfigId];
  const relativeLiveSources = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.sourceType === "live" && isRelativeConfiguredUrl(source.api),
      ),
    [sources],
  );
  const inspectedSource =
    sources.find((source) => source.key === inspectedSourceKey) ?? null;
  const boundScriptArchive =
    inspectedSource?.scriptArchiveId == null
      ? undefined
      : (scriptArchives.find(
          (archive) => archive.id === inspectedSource.scriptArchiveId,
        ) ?? undefined);
  const reportCounts = countParsedCapabilities(report?.sources ?? []);
  const testableSources = useMemo(
    () => sources.filter(isTestableSource),
    [sources],
  );
  /**
   * The sources that cannot currently work: no adapter exists for them, or a test found them
   * broken or empty. A source that passed, or that has simply not been tested yet, is left alone
   * — "untested" is not evidence of being useless, and the user may still want to try it.
   */
  const removableSources = useMemo(
    () =>
      sources.filter(
        (source) =>
          !isTestableSource(source) ||
          source.testStatus === "failed" ||
          source.testStatus === "empty",
      ),
    [sources],
  );
  const removableKeys = useMemo(
    () => new Set(removableSources.map((source) => source.key)),
    [removableSources],
  );
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
  const adapterCounts = useMemo(() => {
    const counts: Record<AdapterExecution, number> = {
      enabled: 0,
      partial: 0,
      "needs-adapter": 0,
      blocked: 0,
    };
    for (const { adapter, sources: matchedSources } of adapterRows) {
      counts[adapter.execution] += matchedSources.length;
    }
    return counts;
  }, [adapterRows]);
  const adapterProfileCounts = useMemo(() => {
    const counts: Record<AdapterExecution, number> = {
      enabled: 0,
      partial: 0,
      "needs-adapter": 0,
      blocked: 0,
    };
    for (const { adapter } of adapterRows) counts[adapter.execution] += 1;
    return counts;
  }, [adapterRows]);
  const visibleAdapterRows = useMemo(
    () =>
      adapterFilter === "all"
        ? adapterRows
        : adapterRows.filter(
            ({ adapter }) => adapter.execution === adapterFilter,
          ),
    [adapterFilter, adapterRows],
  );

  useEffect(() => {
    const sourceBaseUrl = activeDocument?.sourceBaseUrl ?? undefined;
    setConfigBaseUrl(sourceBaseUrl);
    setSourceBaseUrlDraft(sourceBaseUrl ?? "");
  }, [activeDocument?.id, activeDocument?.sourceBaseUrl]);

  // Reset the editors when the active document changes, or when its stored content changes
  // (live-source recovery, base URL repair, source toggles). A base URL change on its own
  // must not reset them: the remote import flow sets the base URL right before loading the
  // fetched text into `importText`, and resetting there would replace that text with the
  // document that is already open. See `shouldResetDrafts`.
  useEffect(() => {
    const next = { documentId: activeConfigId, rawConfig, configBaseUrl };
    if (!shouldResetDrafts(draftSourceRef.current, next)) return;
    draftSourceRef.current = next;
    setRawDraft(rawConfig);
    setImportText(rawConfig);
    setParseResult(
      rawConfig ? parseConfigText(rawConfig, configBaseUrl) : null,
    );
  }, [activeConfigId, configBaseUrl, rawConfig]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void loadActiveConfig()
      .then((document) => {
        if (!cancelled && document) setConfigDocument(document);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [setConfigDocument]);

  useEffect(() => {
    void listScriptArchives()
      .then((archives) => setScriptArchives(archives ?? []))
      .catch(() => setScriptArchives([]));
  }, []);

  useEffect(() => {
    if (
      !isTauriRuntime() ||
      activeConfigId === null ||
      activeDocument?.sourceBaseUrl ||
      relativeLiveSources.length === 0 ||
      liveRecoveryAttempts.current.has(activeConfigId)
    ) {
      return;
    }
    liveRecoveryAttempts.current.add(activeConfigId);
    void recoverKnownLiveSources(activeConfigId)
      .then((document) => {
        if (!document) return;
        setConfigDocument(document);
        setParseState({
          type: "success",
          title: "直播源已自动恢复",
          message:
            "已为旧配置替换为可访问的公开兼容直播列表，请点击连接测试确认当前频道可用。",
        });
      })
      .catch(() => {
        // Keep the manual base URL repair action visible when no known fallback is reachable.
      });
  }, [
    activeConfigId,
    activeDocument?.sourceBaseUrl,
    relativeLiveSources.length,
    setConfigDocument,
  ]);

  const filteredSources = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return sources.filter((source) => {
      const matchesFilter = matchesSourceFilter(source.capability, sourceFilter);
      const matchesQuery =
        !normalizedQuery ||
        [source.name, source.key, source.api].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        );
      return matchesFilter && matchesQuery;
    });
  }, [query, sourceFilter, sources]);

  /** The removable sources among the rows currently listed, which is what bulk pruning acts on. */
  const bulkRemovableSources = useMemo(
    () => filteredSources.filter((source) => removableKeys.has(source.key)),
    [filteredSources, removableKeys],
  );

  const openImportDialog = () => {
    setConfigName(`配置 ${configDocuments.length + 1}`);
    setImportMode("remote");
    setSourceInput("");
    setConfigBaseUrl(undefined);
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

  const [removeRequest, setRemoveRequest] = useState<{
    keys: string[];
    description: string;
  } | null>(null);

  const handleRemoveSources = (
    keys: string[],
    description: string,
    options: { needsConfirmation: boolean },
  ) => {
    if (keys.length === 0) return;
    // Removing a source that cannot run is the ordinary way to tidy a configuration, so it goes
    // through without a prompt. Removing one that works is the surprising case — the user is
    // discarding something usable — and only that asks.
    if (!options.needsConfirmation) {
      void performRemoveSources(keys);
      return;
    }
    setRemoveRequest({ keys, description });
  };

  const performRemoveSources = async (keys: string[]) => {
    try {
      await removeSources(keys);
      if (inspectedSourceKey && keys.includes(inspectedSourceKey)) {
        setInspectedSourceKey(null);
      }
      toast({
        variant: "success",
        title: "已删除源",
        description: `从配置中移除了 ${keys.length} 个源。`,
      });
    } catch (error) {
      toast({
        variant: "error",
        title: "删除失败",
        description: error instanceof Error ? error.message : "删除源失败",
      });
    }
  };

  const confirmRemoveSources = async () => {
    const request = removeRequest;
    if (!request) return;
    setRemoveRequest(null);
    await performRemoveSources(request.keys);
  };

  const handleBindScriptArchive = async (
    source: SourceRecord,
    value: string,
  ) => {
    if (activeConfigId === null) {
      setParseState({
        type: "error",
        message: "请先保存当前配置，再绑定脚本档案。",
      });
      return;
    }
    const archiveId = value === "none" ? null : Number(value);
    if (archiveId !== null && !Number.isInteger(archiveId)) return;
    try {
      const document = await setSourceScriptArchive(
        activeConfigId,
        source.key,
        archiveId,
      );
      if (!document) throw new Error("浏览器预览不会保存脚本档案绑定。");
      setConfigDocument(document);
      setParseState({
        type: "success",
        message:
          archiveId === null
            ? `已解除「${source.name}」的本地脚本绑定。`
            : `已为「${source.name}」绑定本地脚本档案。请启用档案并重新测试该源。`,
      });
    } catch (error) {
      setParseState({
        type: "error",
        message: error instanceof Error ? error.message : "脚本档案绑定失败",
      });
    }
  };

  const handleTestSource = async (source: SourceRecord) => {
    if (testingKeys.has(source.key)) return;
    setTestingKeys((current) => new Set(current).add(source.key));
    try {
      const result = await testSource(source);
      if (!result) {
        throw new Error(
          "浏览器预览不会直接请求 CMS 或直播源，请在 Tauri 桌面应用中测试。",
        );
      }
      const persistedDocument =
        activeConfigId === null
          ? null
          : await updateSourceTest(activeConfigId, source.key, result);
      if (persistedDocument) {
        setConfigDocument(persistedDocument);
      } else {
        setSourceTestResult(source.key, result);
      }
      // Reported as a toast rather than a banner: this describes one finished operation, and a
      // banner left it on the page until the next action replaced it. A test that found the
      // source unusable also switches it off, which is worth saying because the switch in the
      // row will have moved on its own.
      const disabled =
        result.status === "failed" || result.status === "empty";
      toast({
        variant: result.status === "passed" ? "success" : "error",
        title: `${source.name}：${
          result.status === "passed" ? "测试通过" : "测试未通过"
        }`,
        description: `${result.message}${
          disabled ? " 已自动关闭该源的启用开关。" : ""
        }`,
      });
      return result;
    } catch (error) {
      // Reported the same way as a completed test: this is the outcome of the same action, and
      // mixing a toast with a page banner for the failure case would make the error look like a
      // different kind of event.
      toast({
        variant: "error",
        title: `${source.name}：测试失败`,
        description: error instanceof Error ? error.message : "源测试失败",
      });
      return null;
    } finally {
      setTestingKeys((current) => {
        const next = new Set(current);
        next.delete(source.key);
        return next;
      });
    }
  };

  /**
   * Tests a source as part of a batch, without touching the shared status banner.
   *
   * Running the whole list used to write one banner message per source, so the last one to
   * finish overwrote every other result and the summary was the only thing the user ever saw.
   * Per-source outcomes belong on the rows; the banner is for the batch.
   */
  const runBatchTest = async (source: SourceRecord) => {
    setTestingKeys((current) => new Set(current).add(source.key));
    try {
      const result = await testSource(source);
      if (!result) return null;
      const persistedDocument =
        activeConfigId === null
          ? null
          : await updateSourceTest(activeConfigId, source.key, result);
      if (persistedDocument) {
        setConfigDocument(persistedDocument);
      } else {
        setSourceTestResult(source.key, result);
      }
      return result;
    } catch {
      return null;
    } finally {
      setTestingKeys((current) => {
        const next = new Set(current);
        next.delete(source.key);
        return next;
      });
    }
  };

  const handleTestAll = async () => {
    if (testableSources.length === 0) {
      setParseState({
        type: "error",
        message: "当前配置里没有可测试的源。",
      });
      return;
    }
    setIsBatchTesting(true);
    cancelTestRef.current = false;
    // Cancelling has to resolve the batch immediately rather than wait for the requests already
    // in flight. Those cannot be recalled, and a source that hangs is exactly the case the user
    // is cancelling to escape — waiting for it would reproduce the freeze the button exists to
    // fix. The stragglers settle on their own (the backend bounds them) and their results are
    // dropped because the run is already over.
    let releaseCancellation: () => void = () => {};
    const cancelledSignal = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const cancelRequested = () => {
      cancelTestRef.current = true;
      releaseCancellation();
    };
    cancelRunRef.current = cancelRequested;

    const queue = [...testableSources];
    const results: SourceTestResult[] = [];
    // A small worker pool rather than one request at a time or all at once: testing serially made
    // a 70-source configuration take as long as the sum of every source's latency, while firing
    // every request together would open dozens of sockets and trip rate limits.
    const workers = Array.from(
      { length: Math.min(TEST_CONCURRENCY, queue.length) },
      async () => {
        for (;;) {
          if (cancelTestRef.current) return;
          const source = queue.shift();
          if (!source) return;
          const outcome = await Promise.race([
            runBatchTest(source).then((result) => ({ result })),
            cancelledSignal.then(() => null),
          ]);
          if (cancelTestRef.current) return;
          if (outcome?.result) results.push(outcome.result);
        }
      },
    );
    await Promise.all(workers);
    const cancelled = cancelTestRef.current;
    cancelRunRef.current = null;
    setIsBatchTesting(false);

    const passedCount = results.filter(
      (result) => result.status === "passed",
    ).length;
    const disabledCount = results.filter(
      (result) => result.status === "failed" || result.status === "empty",
    ).length;
    if (cancelled) {
      toast({
        variant: "info",
        title: "测速已取消",
        description: `已测试 ${results.length}/${testableSources.length} 个源，其中 ${passedCount} 个通过。其余未测试的源保持原状态。`,
      });
      return;
    }
    toast({
      variant: passedCount === testableSources.length ? "success" : "info",
      title: "测速完成",
      description:
        `已测试 ${results.length} 个源，${passedCount} 个通过` +
        (disabledCount > 0
          ? `，${disabledCount} 个未通过并已自动关闭。`
          : "。"),
    });
  };

  const handleCancelTestAll = () => {
    cancelRunRef.current?.();
  };

  const handleLocalFile = async (file: File) => {
    if (!file) return;
    setImportMode("local");
    setConfigBaseUrl(undefined);
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
      setConfigBaseUrl(new URL(sourceInput.trim()).toString());
      setImportText(text);
      setSelectedFileName("");
      setParseState({
        type: "success",
        message:
          "远程配置已载入；其中 ./ 相对资源路径会按这个 URL 自动解析，请点击解析配置生成报告。",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "远程配置请求失败";
      setParseState({ type: "error", message });
    } finally {
      setIsFetchingRemote(false);
    }
  };

  const handleApplySourceBaseUrl = async () => {
    if (activeConfigId === null) {
      setParseState({
        type: "error",
        message: "请先保存当前配置，再修复相对直播地址。",
      });
      return;
    }
    const value = sourceBaseUrlDraft.trim();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      setParseState({
        type: "error",
        message: "配置基址必须是有效的 HTTP 或 HTTPS URL。",
      });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setParseState({
        type: "error",
        message: "配置基址只允许 HTTP 或 HTTPS URL。",
      });
      return;
    }
    setIsApplyingBaseUrl(true);
    try {
      const document = await setConfigSourceBaseUrl(
        activeConfigId,
        parsed.toString(),
      );
      if (!document) throw new Error("浏览器预览不会保存配置基址。");
      setConfigBaseUrl(document.sourceBaseUrl ?? parsed.toString());
      setSourceBaseUrlDraft(document.sourceBaseUrl ?? parsed.toString());
      setConfigDocument(document);
      setParseState({
        type: "success",
        title: "相对地址已修复",
        message: "直播源地址已按配置基址归一化，请重新测试直播源。",
      });
    } catch (error) {
      setParseState({
        type: "error",
        message: error instanceof Error ? error.message : "配置基址保存失败",
      });
    } finally {
      setIsApplyingBaseUrl(false);
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

  const saveParseError = (error: unknown) => {
    const message =
      error instanceof Error ? error.message : "本地数据库写入失败";
    setParseState({
      type: "error",
      message: `解析成功，但保存失败：${message}`,
    });
  };

  const commitParsedConfig = async (result: ParseResult) => {
    const parsedCounts = countParsedCapabilities(result.sources);
    const name = configName.trim() || `配置 ${configDocuments.length + 1}`;
    const savedDocument = await saveConfigDocument({
      name,
      rawConfig: importText,
      normalizedConfig: result.normalizedConfig,
      sources: result.sources,
      liveCount: result.liveCount,
      sourceBaseUrl: configBaseUrl ?? null,
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
      sourceBaseUrl: configBaseUrl ?? null,
    };
    setConfigDocument(document);
    setParseState({
      type: "success",
      message: `解析完成：${result.sources.length} 个影视源、${result.liveCount} 个直播源；可用 ${parsedCounts.supported} 个，${result.issues.length} 个需要关注。`,
    });
    setImportOpen(false);
    setDuplicateMatch(null);
  };

  const handleParse = async () => {
    setIsParsing(true);
    const result = parseConfigText(importText, configBaseUrl);
    setParseResult(result);

    if (!result.ok) {
      const issue = result.issues[0];
      // Syntax errors carry a line and column; schema mismatches carry a field path instead.
      // Without the path, "expected string, received object" gives no hint about which field
      // in a configuration with hundreds of entries is wrong.
      const location = issue?.line
        ? `（第 ${issue.line} 行，第 ${issue.column ?? 0} 列）`
        : issue?.path && issue.path !== "$"
          ? `（字段 ${issue.path}）`
          : "";
      setParseState({
        type: "error",
        message: `解析失败${location}：${issue?.message ?? "未知解析错误"}`,
      });
      setIsParsing(false);
      return;
    }

    try {
      // Ask before creating a configuration the user probably already has. The check runs
      // here rather than inside the save so the choice stays with the user.
      const match = await findConfigDuplicate({
        rawConfig: importText,
        sourceKeys: result.sources.map((source) => source.key),
        sourceBaseUrl: configBaseUrl ?? null,
      });
      if (match) {
        setDuplicateMatch(match);
        setParseState({ type: "idle", message: "" });
        return;
      }
      await commitParsedConfig(result);
    } catch (error) {
      saveParseError(error);
    } finally {
      setIsParsing(false);
    }
  };

  const handleConfirmDuplicateImport = async () => {
    if (!parseResult?.ok) return;
    setIsParsing(true);
    try {
      await commitParsedConfig(parseResult);
    } catch (error) {
      saveParseError(error);
    } finally {
      setIsParsing(false);
    }
  };

  const handleSkipDuplicateImport = () => {
    const name = duplicateMatch?.documentName ?? "已有配置";
    setDuplicateMatch(null);
    setImportOpen(false);
    setParseState({
      type: "success",
      title: "已跳过导入",
      message: `没有创建新配置：它与「${name}」重复，现有配置保持不变。`,
    });
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
    /* The page fills its viewport and never scrolls as a whole; the source list is the only
       scrolling region. Everything above it is a fixed header, so the list gets the leftover
       height instead of the page growing past the window and pushing the controls off-screen. */
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4 p-5">
        <section className="flex items-center justify-between gap-4 border-b border-border/60 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-lg font-bold tracking-tight text-foreground">
                配置中心
              </h1>
              <Badge variant="secondary">
                {sources.length} 个源
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              管理多套影视与直播配置，随时切换主用配置
            </p>
          </div>
        </section>

        {relativeLiveSources.length > 0 && !activeDocument?.sourceBaseUrl && (
          <Alert variant="destructive">
            <CircleX data-icon="inline-start" aria-hidden="true" />
            <AlertTitle>当前配置包含相对直播地址</AlertTitle>
            <AlertDescription>
              {relativeLiveSources.map((source) => source.name).join("、")}{" "}
              使用了 `./` 路径。旧配置没有保存远程基址，请填入原配置 URL
              后修复；否则直播页无法请求这些源。
              <div className="mt-3 flex items-center gap-2">
                <Input
                  value={sourceBaseUrlDraft}
                  onChange={(event) =>
                    setSourceBaseUrlDraft(event.target.value)
                  }
                  placeholder="https://example.com/path/config.json"
                  aria-label="远程配置基址"
                  className="min-w-0 flex-1 bg-background"
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={isApplyingBaseUrl || !sourceBaseUrlDraft.trim()}
                  onClick={() => void handleApplySourceBaseUrl()}
                >
                  {isApplyingBaseUrl ? "修复中..." : "修复相对地址"}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* The archive is a switcher, not a report. Everything a user does here is pick one, so
            it is a single row: the active name, the list, and a way to remove one. The counts and
            timestamps that used to fill a table are available in the row's own summary line. */}
        <Card className="py-0">
          <CardContent className="flex items-center gap-3 px-4 py-3">
            <Layers3
              className="size-4 shrink-0 text-primary"
              data-icon="inline-start"
              aria-hidden="true"
            />
            <span className="shrink-0 text-sm font-medium">当前配置</span>
            {configDocuments.length > 0 ? (
              <>
                <Select
                  value={activeConfigId ? String(activeConfigId) : ""}
                  onValueChange={(value) => void handleActivate(Number(value))}
                >
                  <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="切换配置">
                    <SelectValue placeholder="选择配置" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {configDocuments.map((document) => (
                        <SelectItem key={document.id} value={String(document.id)}>
                          {document.name} · {document.sourceCount} 个源
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {configDocuments.length} 套
                </span>
                {activeDocument && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`删除配置 ${activeDocument.name}`}
                    onClick={() => setDeleteCandidate(activeDocument)}
                  >
                    <Trash2 className="size-4" data-icon="inline-start" aria-hidden="true" />
                  </Button>
                )}
              </>
            ) : (
              <>
                <span className="flex-1 text-xs text-muted-foreground">
                  还没有配置，导入一份即可开始
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={openImportDialog}
                >
                  <Upload className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                  导入配置
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Tabs
          defaultValue="sources"
          className="flex min-h-0 flex-1 flex-col gap-5"
        >
          <div className="flex shrink-0 items-center justify-between gap-4">
            <TabsList>
              <TabsTrigger value="sources" className="gap-1.5">
                <ListFilter className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                源清单
              </TabsTrigger>
              <TabsTrigger value="adapters" className="gap-1.5">
                <Link2 className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                适配器矩阵
              </TabsTrigger>
              <TabsTrigger value="raw" className="gap-1.5">
                <Code2 className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                原始配置
              </TabsTrigger>
              <TabsTrigger value="report" className="gap-1.5">
                <FileJson className="size-3.5" data-icon="inline-start" aria-hidden="true" />
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

          <TabsContent
            value="sources"
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
              <CardHeader className="shrink-0 border-b pb-4 pt-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <CardTitle className="text-base">源清单</CardTitle>
                    <CardDescription>
                      启用后即可在影视库或直播中使用；测试失败或无内容的源会自动关闭。
                    </CardDescription>
                  </div>
                  {/* Import, export and the bulk test live here rather than in the page header:
                      all three act on the configuration this list is showing, and a page-level
                      "导出" gave no clue what was being exported. */}
                  <div className="flex shrink-0 items-center gap-2">
                    {/* While a batch is running the same control becomes the way out of it. A
                        separate cancel button beside a running one leaves the user choosing
                        between two similar buttons; replacing it means the escape hatch is
                        always where the start button was. */}
                    {isBatchTesting ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={handleCancelTestAll}
                      >
                        <X
                          className="size-3.5"
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        取消测速 ({testingKeys.size}/{testableSources.length})
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={
                          testableSources.length === 0 || testingKeys.size > 0
                        }
                        onClick={() => void handleTestAll()}
                      >
                        <FlaskConical
                          className="size-3.5"
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {`全部测速 (${testableSources.length})`}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={handleExport}
                    >
                      <Download
                        className="size-3.5"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      导出此配置
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={openImportDialog}
                    >
                      <Upload
                        className="size-3.5"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      导入配置
                    </Button>
                    {/* Pruning in bulk: the sources that cannot work are usually the majority,
                        and removing them one at a time is the tedious part of ending up with a
                        configuration that works. It acts only on the rows currently listed, so
                        it can never delete something the user cannot see — and it is hidden
                        under 已适配, where none of those rows are on screen. */}
                    {bulkRemovableSources.length > 0 && sourceFilter !== "available" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          void handleRemoveSources(
                            bulkRemovableSources.map((source) => source.key),
                            "这些无法工作的源",
                            { needsConfirmation: true },
                          )
                        }
                      >
                        <Trash2
                          className="size-3.5"
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        清理不可用 ({bulkRemovableSources.length})
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/60"
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    <Input
                      size="sm"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索源名称或 API"
                      className="pl-8"
                    />
                  </div>
                  <Select
                    value={sourceFilter}
                    onValueChange={(value) =>
                      setSourceFilter(value as SourceFilter)
                    }
                  >
                    <SelectTrigger size="sm" className="w-36 shrink-0" aria-label="筛选状态">
                      <Filter className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                      <SelectValue placeholder="筛选状态" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {/* 全部 first because it is the widest scope and the natural place to
                            start reading, even though 已适配 is what is selected by default. */}
                        <SelectItem value="all">全部</SelectItem>
                        <SelectItem value="available">已适配</SelectItem>
                        <SelectItem value="unusable">未适配</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    共 {filteredSources.length} 个
                  </span>
                </div>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                {filteredSources.length > 0 ? (
                  /* The list is the only scrolling region on the page. It takes whatever height
                     is left after the fixed header above it, so the page itself never scrolls
                     and the controls stay put. */
                  <ScrollArea className="min-h-0 flex-1">
                    <Table containerClassName="overflow-visible">
                      <TableHeader className="sticky top-0 z-10 bg-card">
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-[30%] pl-6">资源名称</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>适配器</TableHead>
                          <TableHead>连接测试</TableHead>
                          <TableHead className="w-16 text-center">启用</TableHead>
                          <TableHead className="w-20 pr-6 text-center">
                            操作
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredSources.map((source) => {
                          const isTesting = testingKeys.has(source.key);
                          return (
                          <TableRow
                            key={source.key}
                            className={cn(
                              "cursor-pointer",
                              // While this row is being tested its own cells fade, so it is obvious
                              // which of several concurrent tests is still outstanding without
                              // watching a spinner in the corner.
                              isTesting && "opacity-60 [&>td]:blur-[1px]",
                            )}
                            onClick={() => setInspectedSourceKey(source.key)}
                          >
                            <TableCell className="pl-6">
                              <div className="flex items-center gap-3">
                                <div className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                  {source.sourceType === "live" ? (
                                    <Globe2
                                      className="size-4"
                                      data-icon="inline-start"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <FileJson
                                      className="size-4"
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
                              <SourceStatusBadge source={source} />
                            </TableCell>
                            <TableCell className="max-w-52">
                              {/* The adapter badge leads, because the first thing to know is
                                  whether an adapter exists at all; the name follows at the same
                                  size as the rest of the row rather than shouting over it. */}
                              <div className="flex min-w-0 items-center gap-2">
                                <AdapterPresenceBadge source={source} />
                                <span className="truncate text-xs text-muted-foreground">
                                  {getAdapterProfile(source).label}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <SourceTestBadge source={source} />
                            </TableCell>
                            <TableCell
                              className="text-center"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {/* A switch that cannot change anything is worse than a disabled
                                  one: it invites a click and silently does nothing. Unusable
                                  sources get a dash, which says "not applicable" honestly. */}
                              {source.capability === "supported" ||
                              source.capability === "partial" ? (
                                <Switch
                                  checked={source.enabled}
                                  onCheckedChange={() =>
                                    void handleToggleSource(source.key)
                                  }
                                  aria-label={`启用 ${source.name}`}
                                />
                              ) : (
                                <span
                                  className="text-xs text-muted-foreground/60"
                                  aria-hidden="true"
                                >
                                  —
                                </span>
                              )}
                            </TableCell>
                            <TableCell
                              className="pr-6"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {/* Centred in a flex row so the two icon buttons line up under the
                                  centred header, and so a row without a test button still has its
                                  delete button in the same place as every other row. */}
                              <div className="flex items-center justify-center gap-1">
                                {isTestableSource(source) && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="group/test relative text-muted-foreground"
                                    disabled={isTesting && !isBatchTesting}
                                    aria-label={
                                      isTesting
                                        ? `取消测试 ${source.name}`
                                        : `测试 ${source.name}`
                                    }
                                    title={
                                      isTesting ? "取消测试" : "测试这个源"
                                    }
                                    onClick={() =>
                                      isTesting
                                        ? handleCancelTestAll()
                                        : void handleTestSource(source)
                                    }
                                  >
                                    {/* A row stuck on "测试中" is where a user looks when they
                                        want it to stop, so the cancel control appears exactly
                                        there on hover rather than only in the toolbar. The
                                        button stays icon-only, so the label moves into the
                                        accessible name and the tooltip. */}
                                    {isTesting ? (
                                      <>
                                        <LoaderCircle
                                          className="size-3.5 animate-spin group-hover/test:hidden"
                                          aria-hidden="true"
                                        />
                                        <X
                                          className="hidden size-3.5 group-hover/test:block"
                                          aria-hidden="true"
                                        />
                                      </>
                                    ) : (
                                      <TestTube2
                                        className="size-3.5"
                                        aria-hidden="true"
                                      />
                                    )}
                                  </Button>
                                )}
                                {/* Deleting is offered on every row. A source that cannot run
                                    goes without a prompt, because tidying those away is the
                                    ordinary case; one that works asks first, because discarding
                                    something usable is the surprising one. */}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  className="text-muted-foreground hover:text-destructive"
                                  aria-label={`删除 ${source.name}`}
                                  title="从配置中删除"
                                  onClick={() =>
                                  handleRemoveSources(
                                    [source.key],
                                    `「${source.name}」`,
                                    {
                                      needsConfirmation:
                                        !removableKeys.has(source.key),
                                    },
                                  )
                                }
                              >
                                <Trash2
                                  className="size-3.5"
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
                    <ScrollBar />
                  </ScrollArea>
                ) : (
                  /* Padded to match the table's own inset: the card's content area has no
                     padding (the table brings its own), so an empty state flush against it
                     pressed its dashed border against the card edge. */
                  <div className="p-4">
                    <Empty className="min-h-72">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Search className="size-4" data-icon="inline-start" aria-hidden="true" />
                        </EmptyMedia>
                        <EmptyTitle>
                          {sourceFilter === "available" && !query.trim()
                            ? "当前配置没有已适配的源"
                            : "没有匹配的源"}
                        </EmptyTitle>
                        <EmptyDescription>
                          {sourceFilter === "available" && !query.trim()
                            ? "这些源都没有可用的适配器。切换到「未适配」可以查看并清理它们。"
                            : "调整关键词或筛选条件后重试。"}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="adapters">
            <div className="grid grid-cols-4 gap-3">
              <AdapterSummary
                label="可执行"
                value={adapterCounts.enabled}
                detail={`${adapterProfileCounts.enabled} 类适配器`}
                execution="enabled"
              />
              <AdapterSummary
                label="部分支持"
                value={adapterCounts.partial}
                detail={`${adapterProfileCounts.partial} 类适配器`}
                execution="partial"
              />
              <AdapterSummary
                label="待适配"
                value={adapterCounts["needs-adapter"]}
                detail={`${adapterProfileCounts["needs-adapter"]} 类适配器`}
                execution="needs-adapter"
              />
              <AdapterSummary
                label="已阻止"
                value={adapterCounts.blocked}
                detail={`${adapterProfileCounts.blocked} 类适配器`}
                execution="blocked"
              />
            </div>
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Link2 className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                      适配器能力矩阵
                    </CardTitle>
                    <CardDescription>
                      适配器能运行不代表源一定可用；测试通过后才能确认内容能取到。
                    </CardDescription>
                  </div>
                  <Select
                    value={adapterFilter}
                    onValueChange={(value) =>
                      setAdapterFilter(value as AdapterFilter)
                    }
                  >
                    <SelectTrigger size="sm" className="w-36" aria-label="筛选适配器状态">
                      <SelectValue placeholder="适配器状态" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">全部适配器</SelectItem>
                        <SelectItem value="enabled">可执行</SelectItem>
                        <SelectItem value="partial">部分支持</SelectItem>
                        <SelectItem value="needs-adapter">待适配</SelectItem>
                        <SelectItem value="blocked">已阻止</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
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
                    {visibleAdapterRows.map(
                      ({ adapter, sources: matchedSources }) => (
                        <TableRow key={adapter.id}>
                          <TableCell className="pl-6">
                            <div>
                              <p className="font-medium">{adapter.label}</p>
                              <p className="mt-1 font-mono text-xs text-muted-foreground">
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
                                    className="text-xs py-0.5 px-2"
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
                      ),
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="raw">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Code2 className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
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
                  <FileJson className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
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
                      title="配置方言"
                      detail={`识别为 ${report.configDialect}，已统一转换为 Moseek 标准源模型`}
                      status="已归一化"
                    />
                    <ReportLine
                      title="HTTP 解析服务"
                      detail={`${report.parseServices.filter((service) => service.capability === "supported").length} 个 GET/POST 服务可在播放时尝试，其他方法仅记录`}
                      status={
                        report.parseServices.some(
                          (service) => service.capability === "supported",
                        )
                          ? "可用"
                          : "未配置"
                      }
                      warning={
                        report.parseServices.length > 0 &&
                        !report.parseServices.some(
                          (service) => service.capability === "supported",
                        )
                      }
                    />
                    <ReportLine
                      title="远程依赖"
                      detail={`${report.sources.filter((source) => Boolean(source.jar)).length} 个源含 JAR 字段，已阻止下载和执行`}
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

        {/* The status banner belongs to the page, not to the import dialog. It used to be
            rendered inside that dialog, so every message it carried — a finished test run, a
            cancelled one, a deleted source — was invisible unless the user happened to have the
            import dialog open. Only the import-specific notice stays there. */}
        {parseState.type !== "idle" && !importOpen && (
          <Alert
            variant={parseState.type === "error" ? "destructive" : "default"}
          >
            {parseState.type === "success" ? (
              <Check className="size-4" data-icon="inline-start" aria-hidden="true" />
            ) : (
              <AlertTriangle className="size-4" data-icon="inline-start" aria-hidden="true" />
            )}
            <AlertTitle>
              {/* A caller-supplied title wins. Forcing "需要修正配置" onto every error meant a
                  cancelled test or a failed source audit announced itself as a broken
                  configuration file, which is a different problem entirely. */}
              {parseState.title ??
                (parseState.type === "success" ? "解析完成" : "需要修正配置")}
            </AlertTitle>
            <AlertDescription>{parseState.message}</AlertDescription>
          </Alert>
        )}
      </div>

      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) setDuplicateMatch(null);
        }}
      >
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
                size="sm"
                className="gap-2"
                onClick={() => {
                  setImportMode("remote");
                  setIsDraggingFile(false);
                  setParseState({ type: "idle", message: "" });
                }}
              >
                <Globe2 className="size-4" data-icon="inline-start" aria-hidden="true" />
                远程 URL
              </Button>
              <Button
                type="button"
                variant={importMode === "local" ? "secondary" : "ghost"}
                size="sm"
                className="gap-2"
                onClick={() => {
                  setImportMode("local");
                  setIsDraggingFile(false);
                  setParseState({ type: "idle", message: "" });
                }}
              >
                <FileUp className="size-4" data-icon="inline-start" aria-hidden="true" />
                本地文件
              </Button>
            </div>
            {importMode === "remote" ? (
              <div className="flex min-h-20 shrink-0 flex-col justify-center gap-2 rounded-md border bg-muted/20 p-3">
                <div className="flex items-center gap-2">
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
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={handleFetchRemote}
                    disabled={isFetchingRemote || !sourceInput.trim()}
                  >
                    <Globe2 className="size-4" data-icon="inline-start" aria-hidden="true" />
                    {isFetchingRemote ? "请求中..." : "获取配置"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  远程配置中的 ./ 相对直播和资源路径会按配置 URL
                  的目录解析；本地文件不会猜测远程基址。
                </p>
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
                    className="gap-1.5"
                    onClick={handleFormatConfig}
                    disabled={!importText.trim()}
                  >
                    <Braces className="size-4" data-icon="inline-start" aria-hidden="true" />
                    格式化
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleRepairConfig}
                    disabled={!importText.trim()}
                  >
                    <WandSparkles className="size-4" data-icon="inline-start" aria-hidden="true" />
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
            {duplicateMatch && (
              <Alert>
                <Info className="size-4" data-icon="inline-start" aria-hidden="true" />
                <AlertTitle>检测到重复配置</AlertTitle>
                <AlertDescription className="flex flex-col gap-1.5">
                  <span>{describeDuplicateMatch(duplicateMatch)}</span>
                  <span className="text-xs">
                    跳过不会改动现有配置；继续导入会另外新建一份配置档。
                  </span>
                </AlertDescription>
              </Alert>
            )}
            {parseState.type !== "idle" && (
              <Alert
                variant={
                  parseState.type === "error" ? "destructive" : "default"
                }
              >
                {parseState.type === "success" ? (
                  <Check className="size-4" data-icon="inline-start" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="size-4" data-icon="inline-start" aria-hidden="true" />
                )}
                <AlertTitle>
                  {/* A caller-supplied title wins. Forcing "需要修正配置" onto every error meant
                      a cancelled test or a failed source audit announced itself as a broken
                      configuration file, which is a different problem entirely. */}
                  {parseState.title ??
                    (parseState.type === "success" ? "解析完成" : "需要修正配置")}
                </AlertTitle>
                <AlertDescription>{parseState.message}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter className="shrink-0">
            {duplicateMatch ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSkipDuplicateImport}
                >
                  <X className="size-4" data-icon="inline-start" aria-hidden="true" />
                  跳过
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => void handleConfirmDuplicateImport()}
                  disabled={isParsing}
                >
                  <FileJson className="size-4" data-icon="inline-start" aria-hidden="true" />
                  {isParsing ? "导入中..." : "继续导入"}
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setImportOpen(false)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  onClick={handleParse}
                  disabled={isParsing || !importText.trim()}
                >
                  <FileJson className="size-4" data-icon="inline-start" aria-hidden="true" />
                  {isParsing ? "解析中..." : "解析配置"}
                </Button>
              </>
            )}
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

      <Dialog
        open={Boolean(removeRequest)}
        onOpenChange={(open) => {
          if (!open) setRemoveRequest(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>从配置中删除这些源？</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  将删除{removeRequest?.description}，共{" "}
                  <span className="font-semibold text-foreground">
                    {removeRequest?.keys.length ?? 0}
                  </span>{" "}
                  个源。
                </p>
                <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  <li>
                    <span className="text-foreground">原始配置会被一起修改</span>
                    ，不是只在这里隐藏。之后重新导入同一份配置，这些源不会回来。
                  </li>
                  <li>该配置的导出结果里也不会再包含它们。</li>
                  <li>
                    相关收藏和播放记录会一并清理。
                  </li>
                  <li>此操作不能撤销。</li>
                </ul>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveRequest(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmRemoveSources()}
            >
              确认删除
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
        <SheetContent className="w-[460px] sm:max-w-[460px] p-0 flex flex-col h-full overflow-hidden border-l border-border/80 bg-card/95 backdrop-blur-md">
          {inspectedSource && (
            <>
              <SheetHeader className="px-6 pt-5 pb-4 border-b border-border/60 bg-card/40 shrink-0">
                <div className="flex items-center gap-2">
                  {/* The same verdict the list shows, so opening the sheet does not appear to
                      disagree with the row that was clicked. */}
                  <SourceStatusBadge source={inspectedSource} />
                  <Badge variant="outline" className="text-xs">
                    {inspectedSource.sourceType === "cms"
                      ? "普通 CMS"
                      : inspectedSource.sourceType === "live"
                        ? "直播源"
                        : "解析服务"}
                  </Badge>
                </div>
                <SheetTitle className="mt-2 text-base font-bold tracking-tight">
                  {inspectedSource.name}
                </SheetTitle>
                {inspectedSource.capabilityNote && (
                  <SheetDescription className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {inspectedSource.capabilityNote}
                  </SheetDescription>
                )}
              </SheetHeader>

              <ScrollArea className="flex-1 min-h-0 w-full overflow-hidden">
                <div className="flex flex-col gap-5 px-6 py-5">
                  <DetailSection title="基本信息">
                    <div className="rounded-lg border border-border/70 bg-card/40 divide-y divide-border/40 overflow-hidden">
                      <DetailRow
                        label="类型"
                        value={
                          inspectedSource.sourceType === "cms"
                            ? "普通 CMS"
                            : inspectedSource.sourceType === "live"
                              ? "直播源"
                              : "解析服务"
                        }
                      />
                      <DetailRow label="标识" value={inspectedSource.key} mono />
                      <DetailRow
                        label="解析格式"
                        value={describeSourceDialect(inspectedSource.sourceDialect)}
                      />
                      {inspectedSource.description && (
                        <DetailRow
                          label="说明"
                          value={inspectedSource.description}
                        />
                      )}
                      <DetailRow
                        label="配置声明可用"
                        value={inspectedSource.status === false ? "否" : "是"}
                      />
                      <DetailRow
                        label="支持搜索"
                        value={inspectedSource.searchable ? "是" : "否"}
                      />
                      <DetailRow
                        label="支持分类"
                        value={inspectedSource.filterable ? "是" : "否"}
                      />
                    </div>
                  </DetailSection>

                  <AdapterDetail source={inspectedSource} />

                  {inspectedSource.sourceType === "cms" &&
                    (inspectedSource.siteProtocol === "js-extension" ||
                      (inspectedSource.scriptArchiveId !== null &&
                        inspectedSource.scriptArchiveId !== undefined)) && (
                      <DetailSection title="本地脚本绑定">
                        <div className="rounded-lg border border-border/70 bg-card/40 p-3 text-xs leading-5 text-muted-foreground">
                          绑定后只会调用本地档案；远程 JS、JAR 和 Spider
                          仍不会自动执行。
                        </div>
                        {inspectedSource.scriptArchiveId !== null &&
                          inspectedSource.scriptArchiveId !== undefined && (
                            <div className="flex items-start gap-3 rounded-lg border border-border/70 bg-card/40 p-3">
                              <Badge
                                variant={
                                  boundScriptArchive === undefined
                                    ? "destructive"
                                    : boundScriptArchive.enabled
                                      ? "default"
                                      : "outline"
                                }
                              >
                                {boundScriptArchive === undefined
                                  ? "档案缺失"
                                  : boundScriptArchive.enabled
                                    ? "可执行"
                                    : "已绑定但停用"}
                              </Badge>
                              <div className="min-w-0 text-xs leading-5">
                                <p className="font-medium text-foreground">
                                  {boundScriptArchive?.name ??
                                    `档案 #${inspectedSource.scriptArchiveId}`}
                                </p>
                                <p className="text-muted-foreground">
                                  {boundScriptArchive === undefined
                                    ? "请重新选择一个本地脚本档案。"
                                    : boundScriptArchive.enabled
                                      ? "现在可以测试该源并使用 CatVod 入口。"
                                      : "先在设置中启用档案，再测试该源。"}
                                </p>
                              </div>
                            </div>
                          )}
                        <Select
                          value={String(
                            inspectedSource.scriptArchiveId ?? "none",
                          )}
                          onValueChange={(value) =>
                            void handleBindScriptArchive(inspectedSource, value)
                          }
                        >
                          <SelectTrigger size="sm" className="w-full">
                            <SelectValue placeholder="选择本地脚本档案" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="none">不绑定</SelectItem>
                              {scriptArchives.map((archive) => (
                                <SelectItem
                                  key={archive.id}
                                  value={String(archive.id)}
                                >
                                  {archive.name}
                                  {archive.enabled ? " · 已启用" : " · 已停用"}
                                  {archive.hasCookie ? " · Cookie 已保护" : ""}
                                  {archive.moduleNames.length > 0
                                    ? ` · 模块 ${archive.moduleNames.length}`
                                    : ""}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </DetailSection>
                    )}

                  <DetailSection title="测试结果">
                    <div className="rounded-lg border border-border/70 bg-card/40 divide-y divide-border/40 overflow-hidden">
                      <DetailRow
                        label="状态"
                        value={testStatusLabel(inspectedSource)}
                      />
                      {inspectedSource.testMessage && (
                        <DetailRow
                          label="说明"
                          value={inspectedSource.testMessage}
                        />
                      )}
                      {inspectedSource.testItemCount !== undefined &&
                        inspectedSource.testStatus === "passed" && (
                          <DetailRow
                            label={
                              inspectedSource.sourceType === "live"
                                ? "识别频道"
                                : "识别内容"
                            }
                            value={`${inspectedSource.testItemCount} 个`}
                          />
                        )}
                      {inspectedSource.testCategoryCount !== undefined &&
                        inspectedSource.testStatus === "passed" && (
                          <DetailRow
                            label={
                              inspectedSource.sourceType === "live"
                                ? "识别分组"
                                : "识别分类"
                            }
                            value={`${inspectedSource.testCategoryCount} 个`}
                          />
                        )}
                      {inspectedSource.testDurationMs !== undefined && (
                        <DetailRow
                          label="耗时"
                          value={`${inspectedSource.testDurationMs} ms`}
                        />
                      )}
                      <DetailRow
                        label="累计请求"
                        value={`${inspectedSource.requestCount} 次`}
                      />
                    </div>

                    {inspectedSource.testOperations &&
                      inspectedSource.testOperations.length > 0 && (
                        <div className="mt-2.5 rounded-lg border border-border/70 bg-card/40 divide-y divide-border/40 overflow-hidden">
                          {inspectedSource.testOperations.map((operation) => (
                            <div
                              key={`${operation.operation}-${operation.message}`}
                              className="flex items-start justify-between gap-3 p-3 text-xs"
                            >
                              <div className="min-w-0">
                                <p className="font-medium text-foreground">
                                  {operationLabel(operation.operation)}
                                </p>
                                <p className="mt-1 leading-5 text-muted-foreground">
                                  {operation.message}
                                </p>
                              </div>
                              <Badge
                                variant="outline"
                                className={cn(
                                  "shrink-0",
                                  operationStatusClass(operation.status),
                                )}
                              >
                                {operationStatusLabel(operation.status)}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      )}
                  </DetailSection>

                  <DetailSection title="接口地址">
                    <div className="rounded-lg border border-border/70 bg-card/40 divide-y divide-border/40 overflow-hidden">
                      <DetailRow label="接口地址" value={inspectedSource.api} mono />
                      {inspectedSource.ext && (
                        <DetailRow label="扩展参数" value={inspectedSource.ext} mono />
                      )}
                      {inspectedSource.jar && (
                        <DetailRow
                          label="远程 JAR"
                          value={inspectedSource.jar}
                          mono
                          danger
                        />
                      )}
                    </div>
                    {inspectedSource.jar && (
                      <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)] p-3 text-xs leading-5 text-[color:var(--status-blocked)]">
                        <ShieldAlert
                          className="mt-0.5 size-4 shrink-0"
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        远程 JAR 已记录但不会下载或执行。
                      </div>
                    )}
                  </DetailSection>
                </div>
              </ScrollArea>

              <SheetFooter className="px-6 py-3.5 border-t border-border/60 bg-card/60 backdrop-blur-xs shrink-0">
                <div className="flex w-full items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        inspectedSource.enabled
                          ? "bg-[color:var(--status-supported)]"
                          : "bg-muted-foreground",
                      )}
                    />
                    <span>{inspectedSource.enabled ? "源已启用" : "源已停用"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {isTestableSource(inspectedSource) && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={testingKeys.has(inspectedSource.key)}
                        onClick={() => void handleTestSource(inspectedSource)}
                      >
                        {testingKeys.has(inspectedSource.key) ? (
                          <LoaderCircle
                            className="size-3.5 animate-spin"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                        ) : (
                          <TestTube2
                            className="size-3.5"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                        )}
                        测试
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void handleToggleSource(inspectedSource.key)
                      }
                    >
                      {inspectedSource.enabled ? "停用此源" : "启用此源"}
                    </Button>
                  </div>
                </div>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function isRelativeConfiguredUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) return false;
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.includes("/")
  );
}

function AdapterSummary({
  label,
  value,
  detail,
  execution,
}: {
  label: string;
  value: number;
  detail: string;
  execution: AdapterExecution;
}) {
  const toneClass = {
    enabled:
      "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)]",
    partial:
      "border-[color:var(--status-partial-border)] bg-[color:var(--status-partial-bg)]",
    "needs-adapter":
      "border-[color:var(--status-adapter-border)] bg-[color:var(--status-adapter-bg)]",
    blocked:
      "border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)]",
  }[execution];
  return (
    <div className={`rounded-md border p-4 ${toneClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">{label}源</p>
          <p className="mt-1 font-display text-2xl font-semibold">{value}</p>
        </div>
        <AdapterStatusBadge execution={execution} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </div>
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
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground/80">
        {title}
      </h3>
      {children}
    </section>
  );
}

function AdapterDetail({ source }: { source: SourceRecord }) {
  const adapter = getAdapterProfile(source);
  return (
    <DetailSection title="适配器边界">
      <div className="rounded-lg border border-border/70 bg-card/40 divide-y divide-border/40 overflow-hidden">
        <div className="flex items-center justify-between gap-3 p-3.5">
          <div>
            <p className="font-semibold text-sm text-foreground">{adapter.label}</p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {adapter.id}
            </p>
          </div>
          <AdapterStatusBadge execution={adapter.execution} />
        </div>
        <div className="p-3.5 text-xs leading-5 text-muted-foreground bg-muted/10">
          {adapter.reason}
        </div>
        {adapter.operations.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 p-3 bg-muted/5">
            <span className="text-xs text-muted-foreground/70 mr-1">支持操作：</span>
            {adapter.operations.map((operation) => (
              <Badge key={operation} variant="secondary" className="text-xs py-0.5 px-2">
                {operation}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </DetailSection>
  );
}

/**
 * A small icon that says whether this source has a working adapter.
 *
 * It replaces the words 可执行 / 未适配, which wrapped onto a second line and read as a status
 * report rather than as a property of the source. The icon leads the adapter cell so the answer
 * to "is this handled at all?" is the first thing seen.
 */
function AdapterPresenceBadge({ source }: { source: SourceRecord }) {
  const usable = isTestableSource(source);
  const Icon = usable ? CircleCheck : CircleX;
  return (
    <Badge
      variant="outline"
      className={cn(
        "size-5 shrink-0 justify-center rounded-full p-0",
        usable
          ? "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]"
          : "border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)] text-[color:var(--status-blocked)]",
      )}
      title={usable ? "已有适配器" : "没有可用适配器"}
    >
      <Icon className="size-3" aria-hidden="true" />
      <span className="sr-only">{usable ? "已有适配器" : "没有可用适配器"}</span>
    </Badge>
  );
}

function SourceStatusBadge({ source }: { source: SourceRecord }) {
  // A source with no working adapter cannot be tested at all, so the adapter verdict is the
  // final word and there is nothing further to say.
  if (!isTestableSource(source)) {
    return <CapabilityBadge status={source.capability} />;
  }
  // The adapter being able to run is a statement about our code, not about the source. Showing
  // 可用 before anything has been fetched told the user the resource works when all we knew was
  // that we had a way to ask. Until a test returns something, the honest word is 待测试.
  const status: SourceTestStatus = source.testStatus ?? "untested";
  const display: Record<
    SourceTestStatus,
    { label: string; tone: CapabilityStatus }
  > = {
    untested: { label: "待测试", tone: "needs-adapter" },
    passed: { label: "可用", tone: "supported" },
    empty: { label: "无内容", tone: "partial" },
    failed: { label: "测试失败", tone: "blocked" },
    blocked: { label: "不可用", tone: "blocked" },
  };
  const { label, tone } = display[status];
  return <CapabilityBadge status={tone} label={label} />;
}

function SourceTestBadge({ source }: { source: SourceRecord }) {
  const status: SourceTestStatus = source.testStatus ?? "untested";
  const isLiveSource = source.sourceType === "live";
  const config: Record<
    SourceTestStatus,
    { label: string; className: string; icon: typeof Check }
  > = {
    untested: {
      label: "未测试",
      className: "text-muted-foreground",
      icon: TestTube2,
    },
    passed: {
      label: `${source.testItemCount ?? 0} ${isLiveSource ? "个频道" : "条内容"}`,
      className: "text-[color:var(--status-supported)]",
      icon: Check,
    },
    empty: {
      label: isLiveSource ? "无频道" : "无影视内容",
      className: "text-[color:var(--status-partial)]",
      icon: Info,
    },
    failed: {
      label: "请求失败",
      className: "text-[color:var(--status-blocked)]",
      icon: CircleX,
    },
    blocked: {
      label: "已阻止",
      className: "text-[color:var(--status-blocked)]",
      icon: ShieldAlert,
    },
  };
  const { icon: Icon, ...display } = config[status];
  return (
    <div className={cn("flex items-center gap-1.5 text-xs", display.className)}>
      <Icon className="size-3.5" data-icon="inline-start" aria-hidden="true" />
      <span>{display.label}</span>
    </div>
  );
}

/** Names a probe in the words a user reads, rather than the operation's internal id. */
function operationLabel(operation: string) {
  return (
    {
      catalog: "获取内容列表",
      category: "读取分类",
      detail: "读取详情",
      playback: "解析播放地址",
      search: "搜索",
    }[operation] ?? operation
  );
}

/** Describes how the source is parsed, in plain language. */
function describeSourceDialect(dialect: string | null | undefined) {
  if (!dialect) return "未知";
  return (
    {
      tvbox: "TVBox 格式",
      "json-http": "JSON 接口",
      "http-extension": "HTTP 扩展",
      "js-extension": "JavaScript 扩展",
    }[dialect] ?? dialect
  );
}

function testStatusLabel(source: SourceRecord) {
  return (
    {
      untested: "尚未测试",
      passed: "通过",
      empty: "没有内容",
      failed: "失败",
      blocked: "未执行（缺少适配器）",
    }[source.testStatus ?? "untested"] ?? "尚未测试"
  );
}

function operationStatusLabel(status: SourceOperationStatus) {
  return {
    passed: "通过",
    empty: "无数据",
    failed: "失败",
    blocked: "阻止",
    skipped: "跳过",
  }[status];
}

function operationStatusClass(status: SourceOperationStatus) {
  return {
    passed:
      "border-[color:var(--status-supported-border)] text-[color:var(--status-supported)]",
    empty:
      "border-[color:var(--status-partial-border)] text-[color:var(--status-partial)]",
    failed:
      "border-[color:var(--status-blocked-border)] text-[color:var(--status-blocked)]",
    blocked:
      "border-[color:var(--status-blocked-border)] text-[color:var(--status-blocked)]",
    skipped: "text-muted-foreground",
  }[status];
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
    <div className="flex items-start justify-between gap-4 px-3.5 py-2 text-xs transition-colors hover:bg-muted/20">
      <span className="shrink-0 font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          "max-w-[280px] break-all text-right font-medium text-foreground",
          mono && "font-mono text-xs",
          danger && "text-[color:var(--status-blocked)] font-semibold",
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
          <ShieldAlert className="size-3.5" data-icon="inline-start" aria-hidden="true" />
        ) : warning ? (
          <Info className="size-3.5" data-icon="inline-start" aria-hidden="true" />
        ) : (
          <Check className="size-3.5" data-icon="inline-start" aria-hidden="true" />
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
