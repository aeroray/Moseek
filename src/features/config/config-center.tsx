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
  Blocks,
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
  Layers3,
  List,
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
  absolutizeRelativeSites,
  mergeRawConfigs,
  mergeSourceLists,
  type MergeReport,
} from "@/features/config/config-merge";
import {
  countParsedCapabilities,
  formatConfigText,
  parseConfigText,
  parseRawObject,
  repairConfigText,
  type ParseResult,
} from "@/features/config/config-parser";
import {
  shouldResetDrafts,
  type DraftSource,
} from "@/features/config/config-drafts";
import {
  activeFilterGroupCount,
  defaultSourceFilter,
  isFilterUnfiltered,
  matchesSourceFilterState,
  type SourceFilterState,
} from "@/features/config/source-filter";
import {
  SourceFilterFacets,
  SourceFilterTrigger,
} from "@/features/config/source-filter-panel";
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
  exportConfig,
  fetchConfigUrl,
  isTauriRuntime,
  loadActiveConfig,
  listScriptArchives,
  recoverKnownLiveSources,
  replaceAllConfigDocuments,
  setConfigSourceBaseUrl,
  setSourceScriptArchive,
  testSource,
  updateSourceTest,
  type StoredConfigDocument,
} from "@/lib/tauri";
import { useAppStore } from "@/stores/app-store";
import type {
  CapabilityStatus,
  SourceDialect,
  SourceOperationStatus,
  ScriptArchiveSummary,
  SourceRecord,
  SourceTestResult,
  SourceTestStatus,
} from "@/types/moseek";

/**
 * The source list's filter.
 *
 * Four independent questions — which adapter, can it run, how did the last test go, is it switched
 * on — grouped in a popover. The words are 已适配 / 未适配 rather than 可用 / 不可用 because the list
 * cannot promise a source works: a source with an adapter may still fail its test, and "可用"
 * claimed otherwise. Whether a particular source actually works is what the 状态 column reports.
 */
type ImportMode = "remote" | "local";

/** The adapter tab's own filter, which narrows a table of adapters rather than of sources. */
type AdapterFilter = "all" | AdapterExecution;

/**
 * How many sources a batch test probes at once.
 *
 * Serial testing made a large configuration take the sum of every source's latency. Testing all
 * of them at once would open as many sockets as there are sources, which trips rate limits and
 * makes every failure look like a local network problem. Four is enough to hide a slow source
 * behind three others without looking like a flood.
 */
const TEST_CONCURRENCY = 4;

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
  const [query, setQuery] = useState("");
  /**
   * The source list's filter.
   *
   * Opens on the sources that can actually run — `executions: ["enabled"]`, the default in
   * `source-filter.ts` — because a configuration carries far more sources than a user can act on
   * and the ones with no runnable adapter are what they may later prune, not what they came to look
   * at. Unlike the previous default it is a visible, clearable choice in the panel rather than a
   * hidden rule, so the list can be widened without discovering a second control.
   */
  const [sourceFilter, setSourceFilter] =
    useState<SourceFilterState>(defaultSourceFilter);
  /** Whether the filter panel is expanded. Closed by default so the list keeps the height. */
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [adapterFilter, setAdapterFilter] = useState<AdapterFilter>("all");
  const [adapterQuery, setAdapterQuery] = useState("");
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
  /**
   * What the last import merged, so the page can state it plainly. A merge that silently changed
   * the source list would leave the user unsure whether their configuration had been replaced.
   */
  const [lastMergeSummary, setLastMergeSummary] = useState<{
    added: number;
    updated: number;
    unchanged: number;
    keptLocalState: number;
    total: number;
  } | null>(null);
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
  /**
   * Counts of adapters, not of sources. The table lists adapters and the filter selects among
   * them, so the number beside a filter option has to answer "how many rows will I get". Counting
   * sources there said "可执行 26 个源" next to a choice that revealed 9 rows.
   */
  const adapterStateCounts = useMemo(() => {
    const counts: Record<AdapterExecution, number> = {
      enabled: 0,
      "needs-adapter": 0,
      blocked: 0,
    };
    for (const { adapter } of adapterRows) counts[adapter.execution] += 1;
    return counts;
  }, [adapterRows]);
  const visibleAdapterRows = useMemo(() => {
    const byState =
      adapterFilter === "all"
        ? adapterRows
        : adapterRows.filter(
            ({ adapter }) => adapter.execution === adapterFilter,
          );
    const keyword = adapterQuery.trim().toLowerCase();
    if (!keyword) return byState;
    // The same fields the row shows, so anything a reader can see is something they can search.
    return byState.filter(({ adapter }) =>
      [adapter.label, adapter.id, adapter.reason]
        .join(" ")
        .toLowerCase()
        .includes(keyword),
    );
  }, [adapterFilter, adapterQuery, adapterRows]);

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

  /**
   * Collapses a multi-document database into the single 中心配置.
   *
   * Moseek used to keep one document per import, so a database written by an older version can hold
   * several. Merging them is the same operation the import path performs, run over what is already
   * stored, and it is deliberately one-shot: it only fires while more than one document exists.
   *
   * Two details make this work at all, and both were learned the hard way:
   *
   * - **The work is not cancelled when the component re-renders.** It is a database migration, not a
   *   render, so it has to run to completion regardless of what React does to this component. The
   *   in-flight promise is held in a ref and a second run joins it rather than starting again.
   * - **The guard records success, not an attempt.** Marking "attempted" before the work began meant
   *   that under `<StrictMode>` — which mounts, cleans up, then mounts again — the first run's
   *   cleanup cancelled the work and the second run refused to start, so the collapse silently never
   *   happened and the page kept showing one of the old documents.
   *
   * The effect keys off the document count rather than the array: `setConfigDocument` reorders
   * The guard is set **synchronously**, before any await, so `<StrictMode>`'s immediate second mount
   * sees it and does not start a second collapse. It is cleared only when the attempt fails, so a
   * transient error can be retried on the next render while a success is never repeated.
   */
  const collapseStarted = useRef(false);
  const configDocumentCount = configDocuments.length;
  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (configDocumentCount <= 1) return;
    if (collapseStarted.current) return;
    collapseStarted.current = true;

    const run = async () => {
      // The ids are read once, so reordering the array afterwards cannot change what is merged.
      const ids = useAppStore.getState().configDocuments.map((item) => item.id);
      const loaded = (
        await Promise.all(
          ids.map((id) => activateConfigDocument(id).catch(() => null)),
        )
      ).filter((document): document is StoredConfigDocument =>
        Boolean(document),
      );
      if (loaded.length <= 1) return;

      // Oldest first, so the configuration the user had longest keeps its position at the top of
      // the merged list and the newer ones append.
      const ordered = [...loaded].sort((a, b) => a.id - b.id);
      let raw = parseRawObject(ordered[0].rawConfig) ?? {};
      let sourceBaseUrl = ordered[0].sourceBaseUrl ?? null;
      let mergedCount = { added: 0, updated: 0, unchanged: 0 };

      for (const document of ordered.slice(1)) {
        // A relative path only means something with the base URL it was imported with, so it is
        // resolved before the two configurations meet.
        const incoming = absolutizeRelativeSites(
          parseRawObject(document.rawConfig) ?? {},
          document.sourceBaseUrl ?? null,
        );
        const result = mergeRawConfigs(raw, incoming);
        raw = result.raw;
        mergedCount = {
          added: mergedCount.added + result.report.sites.added,
          updated: mergedCount.updated + result.report.sites.updated,
          unchanged: mergedCount.unchanged + result.report.sites.unchanged,
        };
        // The merged configuration has to keep one base URL, and a document that carries one is
        // the more useful choice: it is what relative paths in that document were written against.
        sourceBaseUrl = sourceBaseUrl ?? document.sourceBaseUrl ?? null;
      }

      const mergedText = JSON.stringify(raw, null, 2);
      const parsed = parseConfigText(mergedText, sourceBaseUrl ?? undefined);
      if (!parsed.ok) {
        // Surface rather than swallow: silently declining to collapse would leave the user with
        // several documents and no explanation.
        setParseState({
          type: "error",
          title: "合并配置失败",
          message: `合并后的配置无法解析：${parsed.issues[0]?.message ?? "未知解析错误"}。原有配置保持不变。`,
        });
        return;
      }

      // The source list is merged from the stored snapshots rather than taken from the re-parse.
      // Re-parsing is not identity-preserving: the parser resolves a schemeless value against the
      // document's base URL, so parsing the merged text with one document's base rewrites the
      // other documents' relative paths and changes enough identities to drop the user's
      // switches. Merging the snapshots keeps every source exactly as it was stored.
      let mergedSources = ordered[0].sources;
      for (const document of ordered.slice(1)) {
        mergedSources = mergeSourceLists(mergedSources, document.sources).sources;
      }

      const saved = await replaceAllConfigDocuments({
        name: "中心配置",
        rawConfig: mergedText,
        normalizedConfig: parsed.normalizedConfig,
        sources: mergedSources,
        liveCount: parsed.liveCount,
        sourceBaseUrl,
      });
      if (!saved) return;
      setConfigDocument(saved);
      setConfigDocuments([
        {
          id: saved.id,
          name: saved.name,
          sourceCount: saved.sources.length,
          liveCount: saved.liveCount,
          importedAt: saved.importedAt,
        },
      ]);
      setLastMergeSummary({
        added: mergedCount.added,
        updated: mergedCount.updated,
        unchanged: mergedCount.unchanged,
        keptLocalState: saved.sources.filter((source) => !source.enabled).length,
        total: saved.sources.length,
      });
      setParseState({
        type: "success",
        title: "已合并为一套配置",
        message: `原来的 ${ordered.length} 套配置已合并为「中心配置」：新增 ${mergedCount.added} 个源，去重 ${mergedCount.unchanged} 个，当前共 ${saved.sources.length} 个源。以后导入会继续合并进这一套。`,
      });
    };

    void run().catch((error) => {
      // A failed collapse must not block the page — the existing documents stay usable and the
      // next launch tries again — but it must not be silent either. Swallowing the error left the
      // user with several documents and nothing to explain why. The guard is released so the retry
      // can actually happen.
      collapseStarted.current = false;
      setParseState({
        type: "error",
        title: "合并配置失败",
        message: `${error instanceof Error ? error.message : "未知错误"}。原有配置保持不变。`,
      });
    });
    // No cleanup cancels the work: it is a database migration, and abandoning it half-way would
    // leave the database in whatever state the interrupt found.
  }, [configDocumentCount, setConfigDocument, setConfigDocuments]);

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
      const matchesFilter = matchesSourceFilterState(source, sourceFilter);
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

  /**
   * Single tests the user has abandoned, by source key.
   *
   * A request already in flight cannot be recalled, so cancelling means the interface stops waiting
   * and drops the outcome — the same approach the batch cancel takes, for the same reason: a source
   * that hangs is exactly what the user is trying to escape, and waiting for it would reproduce the
   * freeze the button exists to fix. The backend still bounds the request at 25 seconds.
   */
  const cancelledTestKeys = useRef(new Set<string>());

  const handleTestSource = async (source: SourceRecord) => {
    if (testingKeys.has(source.key)) return;
    cancelledTestKeys.current.delete(source.key);
    setTestingKeys((current) => new Set(current).add(source.key));
    try {
      const result = await testSource(source);
      // **Checked before anything is written.** A cancelled test must not persist its result: a
      // failure would switch the source off, so abandoning a test and then having it silently
      // disable the source would be worse than not offering the cancel at all.
      if (cancelledTestKeys.current.has(source.key)) {
        cancelledTestKeys.current.delete(source.key);
        return null;
      }
      if (!result) {
        throw new Error(
          "浏览器预览不会直接请求 CMS 或直播源，请在 Tauri 桌面应用中测试。",
        );
      }
      const persistedDocument =
        activeConfigId === null
          ? null
          : await updateSourceTest(activeConfigId, source.key, result);
      // The persist round-trip is awaited too, so the check is repeated: the user can cancel while
      // the result is being written.
      if (cancelledTestKeys.current.has(source.key)) {
        cancelledTestKeys.current.delete(source.key);
        return null;
      }
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
      if (cancelledTestKeys.current.has(source.key)) {
        cancelledTestKeys.current.delete(source.key);
        return null;
      }
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
   * Abandons a single test.
   *
   * The loading state clears immediately rather than when the request settles, so the row stops
   * looking busy the moment the user asks it to. The outcome is dropped when it arrives.
   */
  const handleCancelTestSource = (sourceKey: string) => {
    cancelledTestKeys.current.add(sourceKey);
    setTestingKeys((current) => {
      const next = new Set(current);
      next.delete(sourceKey);
      return next;
    });
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

    let mergedRawText = importText;
    let mergeReport: MergeReport | null = null;
    if (sources.length > 0 && rawConfig.trim()) {
      // Merging runs on the raw text, not on the parsed sources: the parsed model does not carry
      // every field a TVBox configuration can hold, and regenerating the file from it would discard
      // them silently.
      const existingRaw = parseRawObject(rawConfig);
      const incomingRaw = parseRawObject(
        JSON.stringify(
          absolutizeRelativeSites(
            parseRawObject(importText) ?? {},
            configBaseUrl ?? null,
          ),
        ),
      );
      if (existingRaw && incomingRaw) {
        const { raw, report } = mergeRawConfigs(existingRaw, incomingRaw);
        mergedRawText = JSON.stringify(raw, null, 2);
        mergeReport = report;
      }
    }

    // The source list is merged from the snapshots, not from a re-parse of the merged text.
    // Re-parsing is not identity-preserving: the parser resolves a schemeless value against the
    // document's base URL, so parsing merged text under one document's base rewrites the other
    // document's relative paths and changes identities enough to drop the user's switches.
    const sourceMerge = mergeReport
      ? mergeSourceLists(sources, result.sources)
      : { sources: result.sources, added: 0, updated: 0, unchanged: 0 };
    const finalSources = sourceMerge.sources;
    const mergedParse = mergeReport ? parseConfigText(mergedRawText, configBaseUrl) : result;

    const name = configName.trim() || activeDocument?.name || "中心配置";

    // `replaceAll` rather than `save`: there is exactly one configuration, so the write is "the
    // centre configuration is now this", not "add another one". Using an insert here would quietly
    // reintroduce the pile of documents this feature exists to remove.
    const savedDocument = await replaceAllConfigDocuments({
      name,
      rawConfig: mergedRawText,
      normalizedConfig: mergedParse.ok
        ? mergedParse.normalizedConfig
        : result.normalizedConfig,
      sources: finalSources,
      liveCount: mergedParse.ok ? mergedParse.liveCount : result.liveCount,
      sourceBaseUrl: configBaseUrl ?? activeDocument?.sourceBaseUrl ?? null,
    });
    const document: StoredConfigDocument = savedDocument ?? {
      id: activeConfigId ?? -Date.now(),
      name,
      rawConfig: mergedRawText,
      normalizedConfig: mergedParse.ok
        ? mergedParse.normalizedConfig
        : result.normalizedConfig,
      sources: finalSources,
      sourceCount: finalSources.length,
      liveCount: mergedParse.ok ? mergedParse.liveCount : result.liveCount,
      importedAt: new Date().toISOString(),
      sourceBaseUrl: configBaseUrl ?? activeDocument?.sourceBaseUrl ?? null,
    };
    setConfigDocument(document);
    setLastMergeSummary(
      mergeReport
        ? {
            added: mergeReport.sites.added,
            updated: mergeReport.sites.updated,
            unchanged: sourceMerge.unchanged,
            keptLocalState: finalSources.filter((source) => !source.enabled).length,
            total: finalSources.length,
          }
        : null,
    );
    setParseState({
      type: "success",
      message: mergeReport
        ? `已合并进「${name}」：新增 ${sourceMerge.added} 个源，更新 ${sourceMerge.updated} 个，${sourceMerge.unchanged} 个原本就有；当前共 ${finalSources.length} 个源。`
        : `解析完成：${result.sources.length} 个影视源、${result.liveCount} 个直播源；可用 ${parsedCounts.supported} 个，${result.issues.length} 个需要关注。`,
    });
    setImportOpen(false);
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
      // No duplicate check: importing merges, so a second copy of something already present is
      // deduplicated rather than turned into another document. The prompt that used to guard
      // against that had nothing left to protect.
      await commitParsedConfig(result);
    } catch (error) {
      saveParseError(error);
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
              所有导入都合并进同一份配置，重复的源会自动去重
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

        {/* One configuration, stated once. The switcher that used to live here existed because
            every import made a new document; now an import merges, so there is nothing to switch
            between and the row only reports what the configuration currently is. */}
        <Card className="py-0">
          <CardContent className="flex items-center gap-3 px-4 py-3">
            <Layers3
              className="size-4 shrink-0 text-primary"
              data-icon="inline-start"
              aria-hidden="true"
            />
            <span className="shrink-0 text-sm font-medium">中心配置</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {sources.length > 0
                ? `${sources.length} 个源 · 每次导入都会合并进来`
                : "还没有配置，导入一份即可开始"}
            </span>
            {lastMergeSummary && (
              <span className="shrink-0 text-xs text-muted-foreground">
                上次合并：新增 {lastMergeSummary.added} · 更新{" "}
                {lastMergeSummary.updated} · 已有{" "}
                {lastMergeSummary.unchanged}
              </span>
            )}
            {sources.length === 0 && (
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
                <List className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                源列表
              </TabsTrigger>
              <TabsTrigger value="adapters" className="gap-1.5">
                <Blocks className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                适配器
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
                    <CardTitle className="text-base">源列表</CardTitle>
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
                        configuration that works. It acts only on the rows currently listed, so it
                        can never delete something the user cannot see. That is also why it needs no
                        separate guard for the default view: with the filter on the runnable
                        sources, no removable row is on screen and the button does not appear. */}
                    {bulkRemovableSources.length > 0 && (
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
                {/* The toolbar is a row; the filter panel expands underneath it. The panel is a
                    sibling of the row rather than a child so an open panel pushes the list down
                    instead of squeezing the search box. */}
                <div className="mt-4 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
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
                    <SourceFilterTrigger
                      activeGroupCount={activeFilterGroupCount(sourceFilter)}
                      open={isFilterOpen}
                      onOpenChange={setIsFilterOpen}
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      共 {filteredSources.length} 个
                    </span>
                  </div>
                  {isFilterOpen && (
                    <SourceFilterFacets
                      sources={sources}
                      value={sourceFilter}
                      onChange={setSourceFilter}
                    />
                  )}
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
                                  sources get a dash, which says "not applicable" honestly. The
                                  test is the same predicate the status column uses, so a row can
                                  never offer a switch while telling the user it cannot run. */}
                              {isTestableSource(source) ? (
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
                                    // A row being tested is always cancellable, including on its
                                    // own. This used to be disabled unless a batch was running and
                                    // its cancel reached only the batch, so a single test offered
                                    // an X that did nothing — the one control a user reaches for
                                    // when a row hangs.
                                    aria-label={
                                      isTesting
                                        ? `取消测试 ${source.name}`
                                        : `测试 ${source.name}`
                                    }
                                    title={
                                      isTesting ? "取消测试" : "测试这个源"
                                    }
                                    onClick={() => {
                                      if (!isTesting) {
                                        void handleTestSource(source);
                                        return;
                                      }
                                      // A row that is busy because a batch owns it cancels the
                                      // batch: that is the operation the user is waiting on, and
                                      // stopping only this row would leave the rest running with no
                                      // way to stop them from here.
                                      if (isBatchTesting) {
                                        handleCancelTestAll();
                                        return;
                                      }
                                      handleCancelTestSource(source.key);
                                    }}
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
                          {isFilterUnfiltered(sourceFilter) && !query.trim()
                            ? "当前配置没有源"
                            : "没有匹配的源"}
                        </EmptyTitle>
                        <EmptyDescription>
                          {isFilterUnfiltered(sourceFilter) && !query.trim()
                            ? "导入一份配置后，源会出现在这里。"
                            : "调整关键词或筛选条件后重试。"}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent
            value="adapters"
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
              <CardHeader className="shrink-0 border-b pb-4 pt-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Blocks
                        className="size-4 text-primary"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      适配器
                    </CardTitle>
                    <CardDescription>
                      适配器决定一个源能不能被读取；能运行不代表源一定可用，测试通过后才能确认内容能取到。
                    </CardDescription>
                  </div>
                </div>

                {/* The toolbar is the same one 源列表 uses — search, then filter, then a count —
                    so the two lists are read the same way. The counts used to sit on their own
                    line as clickable buttons, which was a second set of controls doing what the
                    filter already did; they now ride inside the filter options, where the number
                    answers "how many rows will this give me" at the moment of choosing. */}
                <div className="mt-4 flex items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/60"
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    <Input
                      size="sm"
                      value={adapterQuery}
                      onChange={(event) => setAdapterQuery(event.target.value)}
                      placeholder="搜索适配器名称或说明"
                      className="pl-8"
                    />
                  </div>
                  <Select
                    value={adapterFilter}
                    onValueChange={(value) =>
                      setAdapterFilter(value as AdapterFilter)
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-40 shrink-0"
                      aria-label="筛选适配器"
                    >
                      <Filter
                        className="size-3.5"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      <SelectValue placeholder="筛选适配器" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">全部适配器</SelectItem>
                        <SelectItem value="enabled">
                          可执行
                          <span className="ml-auto pl-3 tabular-nums text-muted-foreground">
                            {adapterStateCounts.enabled}
                          </span>
                        </SelectItem>
                        <SelectItem value="needs-adapter">
                          待适配
                          <span className="ml-auto pl-3 tabular-nums text-muted-foreground">
                            {adapterStateCounts["needs-adapter"]}
                          </span>
                        </SelectItem>
                        <SelectItem value="blocked">
                          已阻止
                          <span className="ml-auto pl-3 tabular-nums text-muted-foreground">
                            {adapterStateCounts.blocked}
                          </span>
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    共 {visibleAdapterRows.length} 类
                  </span>
                </div>
              </CardHeader>

              <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                {visibleAdapterRows.length > 0 ? (
                  /* The list is the only scrolling region, matching 源列表: it takes whatever
                     height is left after the fixed header, so the page never scrolls and the
                     controls stay put. Without this the table ran past the bottom of the card. */
                  <ScrollArea className="min-h-0 flex-1">
                    <Table containerClassName="overflow-visible">
                      <TableHeader className="sticky top-0 z-10 bg-card">
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="pl-6">适配器</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>支持操作</TableHead>
                          <TableHead>当前源</TableHead>
                          <TableHead className="pr-6">说明</TableHead>
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
                                        className="px-2 py-0.5 text-xs"
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
                              <TableCell className="max-w-[360px] whitespace-normal pr-6 text-xs leading-5 text-muted-foreground">
                                {adapter.reason}
                              </TableCell>
                            </TableRow>
                          ),
                        )}
                      </TableBody>
                    </Table>
                    <ScrollBar />
                  </ScrollArea>
                ) : (
                  <div className="p-4">
                    <Empty className="min-h-72">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Blocks
                            className="size-4"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                        </EmptyMedia>
                        <EmptyTitle>没有匹配的适配器</EmptyTitle>
                        <EmptyDescription>
                          {adapterQuery.trim()
                            ? "换个关键词，或把筛选切回「全部适配器」。"
                            : "切换筛选条件即可查看全部适配器。"}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent
            value="raw"
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
              <CardHeader className="shrink-0 border-b pb-4 pt-5">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Code2 className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                  原始配置文本
                </CardTitle>
                <CardDescription>
                  可直接编辑原始配置；确认后使用导入流程解析并保存。
                </CardDescription>
              </CardHeader>
              {/* The editor takes the remaining height instead of a fixed 680px. A fixed height
                  made the card 938px tall in an 805px window, and since the page itself is
                  overflow-hidden the bottom of the editor — and the last lines of the
                  configuration — could not be reached at all. */}
              <CardContent className="flex min-h-0 flex-1 flex-col p-3 pt-4">
                <JsonEditor
                  value={editorText}
                  onChange={(value) => {
                    setRawDraft(value);
                    setImportText(value);
                  }}
                  aria-label="原始配置文本"
                  className="min-h-0 flex-1"
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent
            value="report"
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
              <CardHeader className="shrink-0 border-b pb-4 pt-5">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileJson className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                  解析报告
                </CardTitle>
                <CardDescription>
                  按字段和执行边界整理的导入结果。
                </CardDescription>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 overflow-y-auto p-5">
                {report ? (
                  /* One verdict, then two groups of labelled rows.
                     The previous layout was eight equal-weight bordered cards, each an icon plus a
                     heading plus a sentence, so a fatal parse failure and a zero-count security
                     note looked identical and the reader had to read all eight to find the one that
                     mattered. A verdict block answers "did it work" first, and the groups answer
                     "what came in" and "what is being refused" — the two questions the report
                     actually exists for. */
                  <div className="flex flex-col gap-5">
                    <ReportVerdict
                      ok={report.ok}
                      sourceCount={report.sources.length}
                      dialect={report.configDialect}
                      failureMessage={
                        report.issues[0]?.message ?? "配置结构无法解析"
                      }
                    />

                    {report.ok && (
                      <>
                        <ReportGroup title="内容">
                          <ReportRow
                            label="可搜索的源"
                            value={`${reportCounts.supported} 个`}
                          />
                          <ReportRow
                            label="直播源"
                            value={
                              report.liveCount > 0
                                ? `${report.liveCount} 个`
                                : "无"
                            }
                          />
                          <ReportRow
                            label="HTTP 解析服务"
                            value={(() => {
                              const usable = report.parseServices.filter(
                                (service) => service.capability === "supported",
                              ).length;
                              if (report.parseServices.length === 0)
                                return "未配置";
                              return usable > 0
                                ? `${usable} 个可用`
                                : `${report.parseServices.length} 个均不可用`;
                            })()}
                          />
                        </ReportGroup>

                        <ReportGroup title="执行边界">
                          {/* A boundary with a count of zero is good news and does not deserve a
                              row of its own; saying "没有阻止任何内容" once is the honest summary,
                              and it keeps the eye on the boundaries that did fire. */}
                          {reportCounts.blocked === 0 &&
                          reportCounts["needs-adapter"] === 0 &&
                          !report.sources.some((source) => Boolean(source.jar)) ? (
                            <ReportRow
                              label="阻止与限制"
                              value="没有需要阻止的内容"
                              tone="supported"
                            />
                          ) : (
                            <>
                              <ReportRow
                                label="远程依赖"
                                value={`${report.sources.filter((source) => Boolean(source.jar)).length} 个已阻止`}
                                tone="blocked"
                              />
                              <ReportRow
                                label="私有协议"
                                value={`${reportCounts["needs-adapter"]} 个待适配`}
                                tone="warning"
                              />
                              <ReportRow
                                label="危险执行路径"
                                value={`${reportCounts.blocked} 个已阻止`}
                                tone="blocked"
                              />
                            </>
                          )}
                        </ReportGroup>
                      </>
                    )}

                    {report.issues.length > 0 && (
                      <section className="flex flex-col gap-2">
                        {/* No eyebrow: the heading carries its own weight, and the count in it is
                            the part that tells the reader whether to keep going. */}
                        <h3 className="flex items-center gap-2 text-sm font-medium">
                          <AlertTriangle
                            className="size-3.5 text-[color:var(--status-partial)]"
                            aria-hidden="true"
                          />
                          {report.issues.length} 处需要留意
                        </h3>
                        <div className="divide-y divide-border/60 rounded-lg border border-border/60">
                          {report.issues.slice(0, 5).map((issue) => (
                            <div
                              key={`${issue.path}-${issue.message}`}
                              className="flex items-baseline gap-3 px-4 py-2.5"
                            >
                              <span className="shrink-0 font-mono text-xs text-foreground">
                                {issue.path}
                              </span>
                              <span className="min-w-0 text-sm text-muted-foreground">
                                {issue.message}
                              </span>
                              {issue.line && (
                                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                                  第 {issue.line} 行
                                </span>
                              )}
                            </div>
                          ))}
                          {report.issues.length > 5 && (
                            <p className="px-4 py-2.5 text-xs text-muted-foreground">
                              其余 {report.issues.length - 5} 处可在源详情中查看。
                            </p>
                          )}
                        </div>
                      </section>
                    )}
                  </div>
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
              {isParsing ? "合并中..." : "合并进中心配置"}
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
                {describeSourceSituation(inspectedSource) && (
                  <SheetDescription className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {describeSourceSituation(inspectedSource)}
                  </SheetDescription>
                )}
              </SheetHeader>

              <ScrollArea className="flex-1 min-h-0 w-full overflow-hidden">
                <div className="flex flex-col gap-5 px-6 py-5">
                  <DetailSection title="基本信息">
                    <div className="rounded-lg border border-border/70 bg-card/40 divide-y divide-border/40 overflow-hidden">
                      {/* No 类型 row: the header badge above the title already states it, from the
                          same expression, so it was the same words twice in one sheet. */}
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
                      {/* Only shown when the configuration actually switched the source off.
                          It read 是 for all 355 sources in the author's database, so the row was
                          a constant that told the reader nothing. */}
                      {inspectedSource.status === false && (
                        <DetailRow label="配置声明可用" value="否" />
                      )}
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
                          {inspectedSource.testOperations.map((operation, index) => (
                            <div
                              // Keyed by position as well: the same operation can appear twice with
                              // the same message — a retry that failed identically — and a duplicate
                              // key makes React reuse the wrong row.
                              key={`${operation.operation}-${index}`}
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
                      {/* No 接口地址 row: the section heading already says it, and a heading
                          immediately followed by a row of the same words reads as a mistake. */}
                      <DetailRow
                        label="地址"
                        value={inspectedSource.api}
                        mono
                      />
                      {inspectedSource.ext && (
                        <DetailRow
                          label="扩展参数"
                          value={formatExt(inspectedSource.ext)}
                          mono
                        />
                      )}
                      {inspectedSource.jar && (
                        <DetailRow
                          label="远程 JAR"
                          value={inspectedSource.jar}
                          mono
                          danger
                        />
                      )}
                      {/* Live sources carry these and the sheet showed neither, so a channel
                          list's guide and logo addresses were only visible in the raw text. */}
                      {inspectedSource.epg && (
                        <DetailRow
                          label="节目单"
                          value={inspectedSource.epg}
                          mono
                        />
                      )}
                      {inspectedSource.logo && (
                        <DetailRow
                          label="台标"
                          value={inspectedSource.logo}
                          mono
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
                        // The same control both starts and cancels, matching the toolbar's batch
                        // button. It used to disable itself while running, which left the drawer
                        // with no way out of a test that was not finishing — the case where the
                        // user most wants one.
                        onClick={() =>
                          testingKeys.has(inspectedSource.key)
                            ? handleCancelTestSource(inspectedSource.key)
                            : void handleTestSource(inspectedSource)
                        }
                      >
                        {testingKeys.has(inspectedSource.key) ? (
                          <>
                            <X
                              className="size-3.5"
                              data-icon="inline-start"
                              aria-hidden="true"
                            />
                            取消测试
                          </>
                        ) : (
                          <>
                            <TestTube2
                              className="size-3.5"
                              data-icon="inline-start"
                              aria-hidden="true"
                            />
                            测试
                          </>
                        )}
                      </Button>
                    )}
                    {/* The switch is offered on the same condition as the list's, which draws a
                        dash for a source that cannot run. Offering 启用此源 here flipped a flag
                        nothing reads — `enabled` only gates the movie library, and an unrunnable
                        source is excluded from it either way — so the two surfaces disagreed
                        about whether the control existed. */}
                    {isTestableSource(inspectedSource) ? (
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
                    ) : (
                      <span className="text-xs text-muted-foreground/70">
                        该源没有可用适配器，无法启用
                      </span>
                    )}
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

function AdapterStatusBadge({ execution }: { execution: AdapterExecution }) {
  const toneClass = {
    enabled:
      "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
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

/**
 * The one-line explanation shown under a source's name, or null when it would repeat the sheet.
 *
 * Derived from the adapter rather than from `capabilityNote`. That note is written by the parser at
 * import time and never refreshed, exactly like `capability`, so it drifts the moment support is
 * added: in the author's database 101 of 355 notes no longer matched what the code does, and 69 of
 * those told the reader the source was blocked while its adapter runs it — one of them still reading
 * "API 部分可用" for the XBPQ source this whole status cleanup was about.
 *
 * The adapter's reason is also printed in 适配器边界, directly below, so it is returned here only
 * when it would say something that section does not: a malformed record, whose real problem is the
 * missing fields the adapter knows nothing about. Returning null in the ordinary case keeps the
 * sheet from stating the same paragraph twice.
 */
function describeSourceSituation(source: SourceRecord): string | null {
  if (source.capability === "invalid") return source.capabilityNote;
  return null;
}

/**
 * Renders `ext` for display.
 *
 * It is stored as a string, but for XBPQ/Panda sources that string is a JSON blob of URL templates
 * and text markers — up to 514 characters in the author's database. Dumped raw into a 460px sheet it
 * is an unreadable wall of escaped quotes, so the JSON is re-indented when it parses. The JSON5-ish
 * `key:value,key:value` form some packs use is left alone, because reformatting it would change the
 * text the user might compare against their configuration.
 */
function formatExt(ext: string): string {
  const trimmed = ext.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return ext;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    // Not JSON after all; show it as stored rather than mangling it.
    return ext;
  }
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
  // The status column answers "where does this source stand". For a source with no runnable
  // adapter the answer is the adapter's own verdict, not the capability the parser recorded at
  // import time: those are two different questions, and asking the wrong one is what produced a row
  // reading 部分支持 beside an adapter badge reading 没有可用适配器. `AdapterStatusBadge` renders
  // 待适配 / 已阻止, which is the same word the adapter column uses, so the two can never disagree.
  if (!isTestableSource(source)) {
    if (source.capability === "invalid") {
      return <CapabilityBadge status="invalid" />;
    }
    return <AdapterStatusBadge execution={getAdapterProfile(source).execution} />;
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
    // An empty result is not a capability state, so it borrows the warning colour rather than
    // claiming a status the model no longer has.
    empty: { label: "无内容", tone: "needs-adapter" },
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

/**
 * Describes how the source is parsed, in plain language.
 *
 * The map's keys have to be the members of `SourceDialect`, which are `tvbox`, `kitty` and `mixed`.
 * It previously listed `json-http`, `http-extension` and `js-extension` — all `SiteProtocol` values
 * that can never arrive here — and omitted `kitty`, so a CatVod source displayed the raw English
 * identifier "kitty" in an otherwise Chinese sheet. The return type is now the union itself, so a
 * member without a word for it is a compile error rather than something a user discovers.
 */
function describeSourceDialect(
  dialect: SourceDialect | null | undefined,
): string {
  if (!dialect) return "未知";
  const labels: Record<SourceDialect, string> = {
    tvbox: "TVBox 格式",
    kitty: "小猫格式",
    mixed: "混合格式",
  };
  return labels[dialect];
}

/**
 * The word for a test status.
 *
 * `blocked` reads 未执行 rather than 未执行（缺少适配器）. The status has four causes — a spider or
 * remote-JAR family, a record missing its address, an unbound local script archive, or a search the
 * configuration marked unavailable — and only some of them are about an adapter at all. The author
 * hit this on an XBPQ source whose adapter plainly exists, where the parenthetical was simply false.
 * The 说明 row beside it carries the actual reason, so the label only has to say what happened.
 */
function testStatusLabel(source: SourceRecord) {
  return (
    {
      untested: "尚未测试",
      passed: "通过",
      empty: "没有内容",
      failed: "失败",
      blocked: "未执行",
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

/**
 * The one-line answer to "did the import work", stated before any detail.
 *
 * The old report had no verdict at all: 结构解析 was one card among eight, so a failed parse looked
 * like the other seven until the reader got to it.
 */
function ReportVerdict({
  ok,
  sourceCount,
  dialect,
  failureMessage,
}: {
  ok: boolean;
  sourceCount: number;
  dialect: string;
  failureMessage: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4",
        ok
          ? "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)]"
          : "border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)]",
      )}
    >
      {ok ? (
        <CircleCheck
          className="mt-0.5 size-4 shrink-0 text-[color:var(--status-supported)]"
          aria-hidden="true"
        />
      ) : (
        <CircleX
          className="mt-0.5 size-4 shrink-0 text-[color:var(--status-blocked)]"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0">
        <p
          className={cn(
            "font-medium",
            ok
              ? "text-[color:var(--status-supported)]"
              : "text-[color:var(--status-blocked)]",
          )}
        >
          {ok ? `配置解析成功，已识别 ${sourceCount} 个源` : "配置无法解析"}
        </p>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {ok
            ? `识别为 ${dialect} 格式，已统一转换为 Moseek 标准源模型。`
            : failureMessage}
        </p>
      </div>
    </div>
  );
}

/** A named group of report rows. Groups exist so "what came in" and "what is refused" read apart. */
function ReportGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="divide-y divide-border/60 rounded-lg border border-border/60">
        {children}
      </div>
    </section>
  );
}

function ReportRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "supported" | "warning" | "blocked";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-sm font-medium tabular-nums",
          tone === "supported" && "text-[color:var(--status-supported)]",
          tone === "warning" && "text-[color:var(--status-partial)]",
          tone === "blocked" && "text-[color:var(--status-blocked)]",
          !tone && "text-foreground",
        )}
      >
        {value}
      </span>
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
