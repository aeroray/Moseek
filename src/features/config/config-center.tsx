import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  AlertTriangle,
  AlignLeft,
  Blocks,
  Braces,
  Check,
  CircleAlert,
  ChevronDown,
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
  List,
  ListTree,
  LoaderCircle,
  Search,
  Save,
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
import { ConfigVisualEditor } from "@/features/config/config-visual-editor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  type ParseIssue,
  type ParseResult,
} from "@/features/config/config-parser";
import {
  INITIAL_VIEWPORT_HEIGHT,
  SOURCE_ROW_HEIGHT,
  hasLayoutEngine,
  resolveVisibleRows,
} from "@/features/config/source-virtualization";
import {
  shouldResetDrafts,
  type DraftSource,
} from "@/features/config/config-drafts";
import {
  activeFilterGroupCount,
  isFilterUnfiltered,
  matchesSourceFilterState,
} from "@/features/config/source-filter";
import { resolveSavePayload } from "@/features/config/config-autosave";
import {
  readConfigSource,
  type MultiRepoEntry,
} from "@/features/config/config-source";
import {
  SourceFilterFacets,
  SourceFilterTrigger,
} from "@/features/config/source-filter-panel";
import {
  adapterRegistry,
  adapterStatusLabel,
  getAdapterProfile,
  hasScriptArchive,
  isTestableSource,
  type AdapterExecution,
} from "@/lib/adapters";
import { cn, errorMessage } from "@/lib/utils";
import {
  activateConfigDocument,
  cancelSourceTest,
  exportConfig,
  fetchConfigUrl,
  forgetSourceTestRun,
  isTauriRuntime,
  loadActiveConfig,
  listScriptArchives,
  probeScriptAddress,
  recoverKnownLiveSources,
  replaceAllConfigDocuments,
  setConfigSourceBaseUrl,
  setSourceScriptArchive,
  testSource,
  updateSourceTest,
  type ScriptAddressProbe,
  type StoredConfigDocument,
} from "@/lib/tauri";
import { useAppStore } from "@/stores/app-store";
import { isQuotaError } from "@/stores/persist-storage";
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

/** The page's three tabs. */
type ConfigTab = "sources" | "adapters" | "raw";

/**
 * How long the editor waits after the last keystroke before writing.
 *
 * Long enough that typing a key does not trigger a write, short enough that a pause reads as
 * "saved". The status line updates the moment it lands, so the value is not load-bearing.
 */
const AUTO_SAVE_DELAY_MS = 600;

/** The two views of the configuration document. */
type RawMode = "visual" | "code";

/** The adapter tab's own filter, which narrows a table of adapters rather than of sources. */
type AdapterFilter = "all" | AdapterExecution;

/**
 * How many sources a batch test probes at once.
 *
 * Serial testing made a large configuration take the sum of every source's latency, and testing all
 * of them at once would open as many sockets as there are sources, which trips rate limits and makes
 * every failure look like a local network problem.
 *
 * The width was 4 and is now 16, because 4 was chosen for a much smaller list than the user actually
 * has. The cost that would argue against going wider — persisting one result, which rewrites the
 * whole document — was measured at **4.5 ms on a 320-source document and 10.2 ms on a 700-source
 * one**, against per-request budgets of 15 s (reqwest) and 25 s (the test's own outer bound). The
 * database work is therefore three orders of magnitude below the network work, and the batch is
 * bound by the network alone: the user's list is several hundred sources, and a dead source costs
 * its full timeout, so the run's length is dominated by how many of those timeouts can overlap.
 * Four at a time means they mostly queue; sixteen means they mostly do not.
 *
 * 16 rather than "all of them" keeps both real constraints intact. Sources in one configuration are
 * overwhelmingly on different hosts, so 16 concurrent sockets is usually 16 hosts seeing one request
 * each — but it is still bounded, so a configuration that does point many entries at one host cannot
 * turn a test into a flood. And the persistence stays a bounded multiple of a single write: sixteen
 * results landing together is ~160 ms of serialized database work on a 700-source document, which is
 * why `update_source_test` no longer runs on the main thread (see its own comment).
 */
const TEST_CONCURRENCY = 16;

/**
 * How many addresses of a 多仓 list are fetched at once.
 *
 * Matched to `TEST_CONCURRENCY` rather than raised, because the constraint is the same one: the
 * backend bounds each request individually, so the batch width is what decides how many sockets are
 * opened at a time against hosts that owe this client nothing. Four already turns eighteen serial
 * round trips into five waves.
 */
const IMPORT_CONCURRENCY = 4;

/**
 * The marker the backend returns for a test it dropped because the run was cancelled.
 *
 * Mirrors `cms::CANCELLED` in Rust. It is a sentinel rather than an error because a cancelled test
 * is an ordinary outcome, not a failure — but it must never be mistaken for a result, or an
 * abandoned run would still write 测试失败 onto its sources.
 */
const CANCELLED_TEST_MARKER = "__moseek_cancelled__";

/** Whether a test result is really the cancellation sentinel. */
function isCancelledTestResult(result: SourceTestResult): boolean {
  return result.message === CANCELLED_TEST_MARKER;
}

/**
 * Whether this result switched the source's 启用 switch off.
 *
 * The rule is the backend's (`storage::set_source_test_in_connection`): `failed` and `empty` both
 * switch the source off, `passed` and `blocked` leave it alone.
 *
 * **A failure that never reached the server counts too.** This used to exempt transport failures —
 * a timeout, a name that did not resolve, a refused connection — on the theory that they report the
 * network rather than the source. The user's rule is simpler and is what ships: a source we cannot
 * reach is a source we cannot use. So the distinction is gone from the screen as well, because a
 * label nothing acts on is just a second word for the same thing.
 */
function didTestSwitchSourceOff(result: SourceTestResult): boolean {
  return result.status === "failed" || result.status === "empty";
}

/** Whether a rejection was the cancellation, which arrives as a plain string over Tauri's IPC. */
function isCancelledTestError(error: unknown): boolean {
  if (typeof error === "string") return error === CANCELLED_TEST_MARKER;
  if (error instanceof Error) return error.message === CANCELLED_TEST_MARKER;
  if (error && typeof error === "object" && "message" in error) {
    return (error as { message?: unknown }).message === CANCELLED_TEST_MARKER;
  }
  return false;
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
  const [query, setQuery] = useState("");
  /**
   * The source list's filter, held in the store so it survives a restart.
   *
   * It used to be component state, which meant the list reopened on the default every launch and a
   * user working through a narrow slice of a 355-source configuration re-applied the same choices
   * each time. The default is still the opening state for a first run — see `source-filter.ts` — but
   * from then on what the user chose is what they get.
   */
  const sourceFilter = useAppStore((state) => state.sourceFilter);
  const setSourceFilter = useAppStore((state) => state.setSourceFilter);
  const isFilterOpen = useAppStore((state) => state.isSourceFilterOpen);
  const setIsFilterOpen = useAppStore((state) => state.setSourceFilterOpen);
  const [adapterFilter, setAdapterFilter] = useState<AdapterFilter>("all");
  const [adapterQuery, setAdapterQuery] = useState("");
  const [inspectedSourceKey, setInspectedSourceKey] = useState<string | null>(
    null,
  );
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  /**
   * Which view the 原始配置 tab is in.
   *
   * Visual by default: most of what a user does to a configuration — rename a source, fix an
   * address, drop one — does not need a text editor, and opening on 340 lines of JSON presents the
   * hardest possible surface for the easiest task. The code view is one click away for the work that
   * genuinely needs it.
   */
  const [rawMode, setRawMode] = useState<RawMode>("visual");
  /** The result of the last format, validate or repair, shown under the editor. */
  const [rawStatus, setRawStatus] = useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [isSavingRaw, setIsSavingRaw] = useState(false);
  const [parseState, setParseState] = useState<{
    type: "idle" | "success" | "error";
    message: string;
    title?: string;
  }>({ type: "idle", message: "" });
  const [isParsing, setIsParsing] = useState(false);
  /**
   * The 多仓 list the last fetch returned, when it returned one.
   *
   * Held in state rather than shown as an error because it is not a failure: the address lists other
   * configurations and the user wanted one of them. Clearing it dismisses the picker.
   */
  const [multiRepo, setMultiRepo] = useState<{
    entries: MultiRepoEntry[];
    from: string;
  } | null>(null);
  /** Whether the 多仓 bulk import is running, so its button can report progress. */
  const [isImportingAll, setIsImportingAll] = useState(false);
  /**
   * How far the bulk import has got: `{ done, total }`.
   *
   * The loop is sequential — eighteen addresses over eighteen hosts — so with no progress the dialog
   * sat on a button reading "合并中…" for as long as the slowest hosts took, which reads as frozen.
   * A count is the difference between "working" and "stuck".
   */
  const [importProgress, setImportProgress] = useState<{
    done: number;
    total: number;
    current: string;
  } | null>(null);
  /**
   * Which tab is open.
   *
   * Controlled rather than left to Radix's `defaultValue`, because the health rows navigate: a row
   * that says "12 个测试失败" has to be able to open the source list filtered to those twelve, and
   * that needs the page to be able to change its own tab.
   */
  const [activeTab, setActiveTab] = useState<ConfigTab>("sources");
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
  /**
   * The exact text the last save wrote, so a repeat is skipped.
   *
   * A ref rather than state: it must be readable inside the debounce without becoming a reason for
   * the effect to run again, which is the loop it exists to prevent.
   */
  const lastSavedText = useRef<string | null>(null);
  const editorText = rawDraft ?? rawConfig;
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
  const testableSources = useMemo(
    () => sources.filter(isTestableSource),
    [sources],
  );
  /** The testable sources with no result yet, which is the narrower test scope. */
  const untestedSources = useMemo(
    () =>
      testableSources.filter(
        (source) => (source.testStatus ?? "untested") === "untested",
      ),
    [testableSources],
  );
  /**
   * The sources that cannot currently work: no adapter exists for them, or a test found them
   * broken or empty. A source that passed, or that has simply not been tested yet, is left alone
   * — "untested" is not evidence of being useless, and the user may still want to try it.
   *
   * A source we could not reach counts, and that is the user's explicit decision: a source we
   * cannot reach is a source we cannot use, so it is 测试失败 like any other and belongs in the set
   * this button prunes. The rule is the same one the switch follows, so the count and the switches
   * can never disagree.
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
    setImportMode("remote");
    setSourceInput("");
    setConfigBaseUrl(undefined);
    setSelectedFileName("");
    setImportText("");
    setParseState({ type: "idle", message: "" });
    setImportOpen(true);
  };

  /**
   * These handlers are `useCallback`s so the source table's `memo` is not defeated.
   *
   * The table is memoised because typing in the import dialog was re-rendering all 358 of its rows.
   * `memo` compares props by identity, so a handler recreated on every render would make the whole
   * thing decorative — the table would still re-render on every keystroke, and the fix would look
   * applied while changing nothing. Every dependency below is a store action or a `useState` setter,
   * both stable, or a value that does not change while the user is typing in the dialog.
   */
  const handleToggleSource = useCallback(
    async (sourceKey: string) => {
      try {
        await toggleSource(sourceKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : "源状态保存失败";
        setParseState({ type: "error", message });
      }
    },
    [toggleSource],
  );

  const [removeRequest, setRemoveRequest] = useState<{
    keys: string[];
    description: string;
  } | null>(null);
  /**
   * Whether a removal is in flight, so the dialog can say so instead of appearing frozen.
   *
   * The button used to look inert while the work happened: the config rewrite is a single blocking
   * call, and on a large document that was measured at ~2 seconds before it was made fast. Even now
   * it is not instant, and a destructive action with no acknowledgement is the one place a user is
   * most likely to click again.
   */
  const [isRemoving, setIsRemoving] = useState(false);

  const performRemoveSources = useCallback(
    async (keys: string[]) => {
      setIsRemoving(true);
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
      } finally {
        setIsRemoving(false);
      }
    },
    [removeSources, inspectedSourceKey, toast],
  );

  /** Decides whether removing a source needs a prompt. Stable for the same reason as its neighbours. */
  const handleRemoveSources = useCallback(
    (
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
    },
    [performRemoveSources],
  );

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
   * This used to be the whole mechanism: the interface stopped waiting and dropped the outcome, and
   * the comment here said the request "cannot be recalled". That is true of a promise, but not of
   * the socket — dropping the backend future closes it. So each single test now gets its own run id
   * and cancelling calls `cancelSourceTest` on it, which is what actually stops the download. The
   * key set is kept because the outcome still has to be ignored if it arrives during the race.
   */
  const cancelledTestKeys = useRef(new Set<string>());
  /** The run id each in-flight single test is registered under, so cancelling can reach it. */
  const singleTestRunIds = useRef(new Map<string, string>());

  const handleTestSource = useCallback(
    async (source: SourceRecord) => {
      if (testingKeys.has(source.key)) return;
    cancelledTestKeys.current.delete(source.key);
    const runId = `single-${source.key}-${Date.now()}`;
    singleTestRunIds.current.set(source.key, runId);
    setTestingKeys((current) => new Set(current).add(source.key));
    try {
      const result = await testSource(source, runId);
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
      // The backend answers a dropped request with the sentinel instead of a result. Treated the
      // same as a local cancellation: it must not be written.
      if (isCancelledTestResult(result)) return null;
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
      // row will have moved on its own. Every failure counts, including one that never reached the
      // server — see `didTestSwitchSourceOff`.
      toast({
        variant: result.status === "passed" ? "success" : "error",
        title: `${source.name}：${
          result.status === "passed" ? "测试通过" : "测试未通过"
        }`,
        description: `${result.message}${
          didTestSwitchSourceOff(result) ? " 已自动关闭该源的启用开关。" : ""
        }`,
      });
      return result;
    } catch (error) {
      if (cancelledTestKeys.current.has(source.key)) {
        cancelledTestKeys.current.delete(source.key);
        return null;
      }
      // A dropped request rejects rather than resolving with the sentinel, so the cancellation has
      // to be recognised here too — otherwise abandoning a test would report it as a failure.
      if (isCancelledTestError(error)) return null;
      // Reported the same way as a completed test: this is the outcome of the same action, and
      // mixing a toast with a page banner for the failure case would make the error look like a
      // different kind of event.
      toast({
        variant: "error",
        title: `${source.name}：测试失败`,
        description: errorMessage(error, "源测试失败"),
      });
      return null;
    } finally {
      singleTestRunIds.current.delete(source.key);
      setTestingKeys((current) => {
        const next = new Set(current);
        next.delete(source.key);
        return next;
      });
    }
    },
    [
      activeConfigId,
      setConfigDocument,
      setSourceTestResult,
      testSource,
      testingKeys,
      toast,
    ],
  );

  /**
   * Abandons a single test.
   *
   * The loading state clears immediately rather than when the request settles, so the row stops
   * looking busy the moment the user asks it to. The outcome is dropped when it arrives.
   *
   * It also reaches the backend, which is the part that was missing: clearing the row and dropping
   * the outcome left the request running until its own 25 s bound, so a cancelled test kept
   * downloading and kept the row's source busy. `cancelSourceTest` drops the future, which closes
   * the connection.
   */
  const handleCancelTestSource = useCallback((sourceKey: string) => {
    cancelledTestKeys.current.add(sourceKey);
    const runId = singleTestRunIds.current.get(sourceKey);
    if (runId) {
      void cancelSourceTest(runId)
        .then(() => forgetSourceTestRun(runId))
        .catch(() => undefined);
    }
    setTestingKeys((current) => {
      const next = new Set(current);
      next.delete(sourceKey);
      return next;
    });
  }, []);

  /**
   * Tests a source as part of a batch, without touching the shared status banner.
   *
   * Running the whole list used to write one banner message per source, so the last one to
   * finish overwrote every other result and the summary was the only thing the user ever saw.
   * Per-source outcomes belong on the rows; the banner is for the batch.
   */
  const runBatchTest = async (source: SourceRecord, runId: string) => {
    setTestingKeys((current) => new Set(current).add(source.key));
    try {
      const result = await testSource(source, runId);
      if (!result) return null;
      // **A cancelled test must not be written.** The backend returns a sentinel rather than a
      // result when it drops the request, and persisting that would mark the source 测试失败 — or
      // switch it off — on the strength of a run the user explicitly abandoned. This is the same
      // rule the single-row cancel already follows; the batch path was missing it, so a cancelled
      // batch kept mutating the source list as the abandoned requests landed.
      if (isCancelledTestResult(result)) return null;
      const persistedDocument =
        activeConfigId === null
          ? null
          : await updateSourceTest(activeConfigId, source.key, result);
      // The user can cancel while the result is being written, so the check is repeated after the
      // round-trip: the write may already be in flight when the cancel arrives.
      if (cancelTestRef.current) return null;
      if (persistedDocument) {
        setConfigDocument(persistedDocument);
      } else {
        setSourceTestResult(source.key, result);
      }
      return result;
    } catch (error) {
      // A cancelled request rejects rather than resolving with a sentinel, so the cancellation has
      // to be recognised here too, or it would be reported as a per-source failure.
      if (isCancelledTestError(error)) return null;
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
   * Runs a batch test over `targets`.
   *
   * `targets` is passed in rather than read from `testableSources` so the caller decides the scope:
   * "全部测速" and "只测未测过的" differ only in which sources they hand over, and everything else —
   * the worker pool, the cancel path, the summary — is identical. Duplicating the batch machinery for
   * the second scope would mean two cancel paths and two summaries to keep in step.
   */
  const runTestBatch = async (targets: SourceRecord[]) => {
    if (targets.length === 0) {
      setParseState({
        type: "error",
        message: "当前配置里没有可测试的源。",
      });
      return;
    }
    setIsBatchTesting(true);
    cancelTestRef.current = false;
    /**
     * This run's identity, which is what makes cancelling reach the sockets.
     *
     * The previous implementation only stopped the frontend from waiting: the requests stayed open
     * in Rust until their own 25 s bound and each still persisted its result, so the list kept
     * changing after "测速已取消" had been reported. A per-run id is what lets `cancelSourceTest`
     * drop exactly this batch's requests without touching a later run.
     */
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    /**
     * Cancelling now does two things, and it needs both.
     *
     * `cancelSourceTest` reaches into the backend and drops the in-flight futures — that is what
     * actually closes the connections. `releaseCancellation` stops the worker pool from starting
     * anything new and lets the summary resolve without waiting for the drops to be acknowledged.
     * Only doing the second was the reported bug: the sockets stayed open.
     */
    let releaseCancellation: () => void = () => {};
    const cancelledSignal = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const cancelRequested = () => {
      cancelTestRef.current = true;
      releaseCancellation();
      // Fire-and-forget: the local state is already correct, and making the button await a
      // round-trip would reintroduce the delay this exists to remove.
      void cancelSourceTest(runId).catch(() => undefined);
    };
    cancelRunRef.current = cancelRequested;

    const queue = [...targets];
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
            runBatchTest(source, runId).then((result) => ({ result })),
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
    // The run is over, so its flag is released. Without this a long session of many batches would
    // accumulate one entry per run for the process's lifetime.
    void forgetSourceTestRun(runId).catch(() => undefined);

    const passedCount = results.filter(
      (result) => result.status === "passed",
    ).length;
    // Every failure counts, including one that never reached the server — a source we cannot reach
    // is a source we cannot use, so it is switched off and counted here.
    const disabledCount = results.filter(didTestSwitchSourceOff).length;
    if (cancelled) {
      toast({
        variant: "info",
        title: "测速已取消",
        description: `已测试 ${results.length}/${targets.length} 个源，其中 ${passedCount} 个通过。其余未测试的源保持原状态。`,
      });
      return;
    }
    toast({
      variant: passedCount === targets.length ? "success" : "info",
      title: "测速完成",
      description:
        `已测试 ${results.length} 个源，${passedCount} 个通过` +
        (disabledCount > 0
          ? `，${disabledCount} 个未通过并已自动关闭。`
          : "。"),
    });
  };

  /** Every testable source, whether or not it has been tested before. */
  const handleTestAll = () => void runTestBatch(testableSources);

  /**
   * Only the testable sources that have never been tested.
   *
   * The user asked for this because a configuration is largely tested already, and re-testing all of
   * it spends the wait on sources whose result is known — while the ones actually in doubt are the
   * ones with no result at all. `untested` is the absence of evidence, which is exactly the set worth
   * spending a request on.
   */
  const handleTestUntested = () =>
    void runTestBatch(
      testableSources.filter((source) => (source.testStatus ?? "untested") === "untested"),
    );

  const handleCancelTestAll = useCallback(() => {
    cancelRunRef.current?.();
  }, []);

  const handleLocalFile = async (file: File) => {
    if (!file) return;
    setImportMode("local");
    setConfigBaseUrl(undefined);
    setSelectedFileName(file.name);
    setIsDraggingFile(false);
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

  /**
   * Fetches a configuration address and turns whatever it serves into something usable.
   *
   * Several of the addresses users paste do not serve a configuration at all. Measured across the ten
   * the owner supplied: one serves a JPEG with the configuration appended to it, one serves JSON with
   * an HTML footer, two serve a landing page, one is a 404, and two serve a 多仓 subscription list of
   * other addresses. Reporting any of those as "invalid JSON" would be true and useless, so each gets
   * the response it needs — and a 多仓 list gets a picker rather than being discarded.
   */
  const handleFetchRemote = async () => {
    if (!sourceInput.trim()) {
      setParseState({ type: "error", message: "请输入配置 URL。" });
      return;
    }
    setIsFetchingRemote(true);
    try {
      const fetched = await fetchConfigUrl(sourceInput.trim());
      if (!fetched) {
        setParseState({
          type: "error",
          message:
            "浏览器预览不会直接请求远程配置，请在 Tauri 桌面应用中使用此功能。",
        });
        return;
      }

      // An address that served nothing but a picture. Saying which picture, and that it held no
      // configuration, is more useful than a parse error about binary bytes.
      if (!fetched.text) {
        setParseState({
          type: "error",
          message: fetched.note ?? "这个地址没有返回配置内容。",
        });
        return;
      }

      const source = readConfigSource(fetched.text, fetched.note);
      setConfigBaseUrl(new URL(sourceInput.trim()).toString());
      setSelectedFileName("");

      if (source.kind === "multi-repo") {
        // Not a configuration, but not a failure either: it lists addresses, and the user wanted one
        // of them. Offering the list is the whole point of recognising this shape.
        setMultiRepo({ entries: source.entries, from: sourceInput.trim() });
        setParseState({ type: "idle", message: "" });
        return;
      }

      if (source.kind === "landing-page") {
        setParseState({
          type: "error",
          message: source.note,
        });
        return;
      }

      // Repair before showing the text, because a downloaded configuration is not the user's own
      // writing and a publisher's typo should not cost them the whole file. Measured: 肥猫's published
      // document has two keys missing their opening quote, and without this the user sees
      // `invalid character '"' at 125:4` and has to fix someone else's mistake by hand.
      //
      // Only a document that FAILS to parse is touched, so a working configuration is never rewritten
      // on the way in — that would silently discard the author's comments and formatting.
      const repaired = parseConfigText(source.text, sourceInput.trim()).ok
        ? null
        : repairConfigText(source.text);
      const text =
        repaired?.ok === true && repaired.text !== source.text ? repaired.text : source.text;
      const repairNote =
        repaired?.ok === true && repaired.text !== source.text
          ? `已自动修正：${repaired.changes.join("、")}`
          : null;

      setImportText(text);
      setParseState({
        type: "success",
        message:
          [source.note, repairNote].filter(Boolean).join("；") +
          (source.note || repairNote ? "；" : "") +
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

  /**
   * Fetches every address in a 多仓 list and merges them all into the centre configuration at once.
   *
   * The user asked for this because picking eighteen addresses one at a time is eighteen round trips
   * through a dialog that only ever loads one of them into the editor — and the editor can only hold
   * one document, so "select all" was not expressible before this existed.
   *
   * Failures are collected rather than thrown. With eighteen addresses, some are dead: measured on
   * the owner's list, one of the eighteen is a host that no longer resolves. Aborting the whole batch
   * because one address is dead would be the worst outcome — the user would get nothing and no
   * explanation of which one broke. So each address is tried, the ones that work are merged, and the
   * ones that did not are named.
   */
  const handleImportAllMultiRepo = async () => {
    const request = multiRepo;
    if (!request) return;
    // The picker stays open while the batch runs, and that is deliberate: it is where the progress
    // belongs, and closing it left the user looking at a dialog with a button that said "合并中…" and
    // nothing else for as long as eighteen hosts took.
    setIsImportingAll(true);
    setImportProgress({ done: 0, total: request.entries.length, current: request.entries[0]?.name ?? "" });
    try {
      const documents: string[] = [];
      const failed: string[] = [];

      /**
       * Concurrently, because serial was measurably slow.
       *
       * The eighteen addresses in the owner's list live on eighteen different hosts, so fetching them
       * one at a time costs the SUM of eighteen round trips and eighteen TLS handshakes while the
       * client sits idle between each. They do not depend on each other in any way — each is fetched,
       * repaired and kept as its own document, and only the merge afterwards needs them all — so the
       * only thing serialising them bought was a longer wait.
       *
       * The pool is bounded rather than `Promise.all` over every address: eighteen simultaneous
       * requests to eighteen hosts is fine, but a list of a hundred is not, and the backend bounds
       * each request individually rather than the batch. `IMPORT_CONCURRENCY` is the same width the
       * source tester already uses for the same reason.
       *
       * Order is preserved in the result even though the fetches finish out of order, so the merged
       * document's source order still follows the list the user was shown.
       */
      const outcomes: Array<{ name: string; text: string | null }> = new Array(
        request.entries.length,
      );
      let completed = 0;
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(IMPORT_CONCURRENCY, request.entries.length) },
        async () => {
          for (;;) {
            const index = cursor;
            cursor += 1;
            const entry = request.entries[index];
            if (!entry) return;
            let text: string | null = null;
            try {
              const fetched = await fetchConfigUrl(entry.url);
              if (fetched?.text) {
                const source = readConfigSource(fetched.text, fetched.note);
                if (source.kind === "config") {
                  // Each address is repaired on its own, because a publisher's typo should not cost
                  // the whole batch — this is the same pass the single-address path runs.
                  const parsed = parseConfigText(source.text, entry.url);
                  let working = source.text;
                  if (!parsed.ok) {
                    const repaired = repairConfigText(source.text);
                    if (repaired.ok) working = repaired.text;
                  }
                  /**
                   * **Absolutised here, while this entry's own URL is still known.**
                   *
                   * A relative path inside an entry was written against THAT entry's address, and the
                   * merged document can only keep one base — so leaving it relative loses the only
                   * information that could ever resolve it. Measured against the author's real 多仓
                   * list: the entry `SVIP📚在线` contributes 14 live sources addressed `./FM.json`,
                   * `./lib/tv/ipv6.m3u` and so on, and every one of them was unusable afterwards.
                   * Resolved against its own URL, `./FM.json` returns a real playlist
                   * (`电台,#genre#` / `Soft Rock,https://stream.revma.ihrhls.com/...`).
                   */
                  const raw = parseRawObject(working);
                  text = raw
                    ? JSON.stringify(absolutizeRelativeSites(raw, entry.url))
                    : working;
                }
              }
            } catch {
              // Collected below, not thrown: with eighteen addresses some are dead, and aborting the
              // batch would give the user nothing and no explanation of which one broke.
              text = null;
            }
            outcomes[index] = { name: entry.name, text };
            completed += 1;
            // The count advances as each finishes rather than as each starts, which is the only
            // progress figure that is true when several are in flight at once.
            setImportProgress({
              done: completed,
              total: request.entries.length,
              current: entry.name,
            });
          }
        },
      );
      await Promise.all(workers);

      for (const outcome of outcomes) {
        if (outcome?.text) documents.push(outcome.text);
        else if (outcome) failed.push(outcome.name);
      }

      if (documents.length === 0) {
        setParseState({
          type: "error",
          message: `这份列表里的 ${request.entries.length} 个配置都没有取到内容。`,
        });
        return;
      }

      // Merge them into ONE document, then commit it through the ordinary import path. Doing the
      // merge first is what keeps this from being eighteen separate imports, each of which would
      // rewrite the stored configuration in turn.
      let merged = documents[0];
      for (const next of documents.slice(1)) {
        const existing = parseRawObject(merged);
        const incoming = parseRawObject(next);
        if (!existing || !incoming) continue;
        merged = JSON.stringify(mergeRawConfigs(existing, incoming).raw);
      }

      // The base URL is deliberately NOT set here. Eighteen addresses usually live on eighteen
      // different hosts, so there is no single directory a relative path could resolve against;
      // picking one would silently rewrite the others' addresses. `absolutizeRelativeSites` in the
      // import path leaves them as written instead, which is honest about what we know.
      const parsedMerged = parseConfigText(merged, undefined);
      if (!parsedMerged.ok) {
        setParseState({
          type: "error",
          message: `合并后的配置无法解析：${parsedMerged.issues[0]?.message ?? "未知错误"}`,
        });
        return;
      }

      // Committed directly rather than left in the editor for a second confirmation. The user asked
      // for "一键合并导入" — one action — and the button says 合并导入, not 载入.
      await commitParsedConfig(parsedMerged, {
        rawOverride: merged,
        successNote:
          `已合并导入 ${documents.length} 份配置` +
          (failed.length > 0
            ? `；${failed.length} 个地址没有取到配置：${failed.slice(0, 3).join("、")}${failed.length > 3 ? " 等" : ""}。`
            : "。"),
      });
      // Closed only on success: on a failure the picker is where the user can retry or pick one
      // address by hand, so closing it would take that away.
      setMultiRepo(null);
    } catch (error) {
      setParseState({
        type: "error",
        message: error instanceof Error ? error.message : "批量导入失败",
      });
    } finally {
      setIsImportingAll(false);
      setImportProgress(null);
    }
  };

  /** Loads one address from a 多仓 list, the way the user would have pasted it themselves. */
  const handlePickMultiRepo = async (url: string) => {
    setMultiRepo(null);
    setSourceInput(url);
    setIsFetchingRemote(true);
    try {
      const fetched = await fetchConfigUrl(url);
      if (!fetched?.text) {
        setParseState({ type: "error", message: fetched?.note ?? "这个地址没有返回配置内容。" });
        return;
      }
      const source = readConfigSource(fetched.text, fetched.note);
      setConfigBaseUrl(new URL(url).toString());
      if (source.kind !== "config") {
        // A 多仓 list pointing at another 多仓 list is possible, but nesting the picker would be a
        // worse experience than saying so.
        setParseState({ type: "error", message: source.note });
        return;
      }
      setImportText(source.text);
      setParseState({
        type: "success",
        message: `${source.note ? `${source.note}；` : ""}已载入「${url}」。`,
      });
    } catch (error) {
      setParseState({
        type: "error",
        message: error instanceof Error ? error.message : "远程配置请求失败",
      });
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

  /**
   * Writes an edit from either view into the raw draft.
   *
   * One path in and one place the draft changes, so the two views cannot disagree. It deliberately
   * does **not** touch `importText`: that is the import dialog's own buffer, and feeding raw-tab
   * edits into it would mean opening 导入配置 later showed — and could merge — text the user had
   * already saved, rather than the text they are about to import.
   */
  const handleRawTextChange = (value: string) => {
    setRawDraft(value);
  };

  /** Turns a parse issue into a message that names where it is. */
  const describeRawIssue = (prefix: string, issue: ParseIssue | null | undefined) => {
    const position = issue?.line
      ? `（第 ${issue.line} 行，第 ${issue.column ?? 0} 列）`
      : "";
    return `${prefix}${position}：${issue?.message ?? "未知解析错误"}`;
  };

  /**
   * Re-indents the configuration.
   *
   * The same operation the import dialog offers, applied to the open document rather than to text
   * being imported. It is the first thing to try on a file that has been pasted together by hand,
   * and it is also what makes the code view readable again after a visual edit.
   */
  const handleFormatRaw = () => {
    const result = formatConfigText(editorText);
    if (!result.ok) {
      setRawStatus({ tone: "error", message: describeRawIssue("格式化失败", result.issue) });
      return;
    }
    handleRawTextChange(result.text);
    setRawStatus({ tone: "success", message: "已重新排版。" });
  };

  /**
   * Checks the configuration and repairs what it can, in one action.
   *
   * 校验 and 自动修正 were two buttons over the same text, and the pair was backwards: 校验 only
   * reported what 自动修正 could then fix, so the user had to read the diagnosis and press a second
   * button for the obvious next step. Worse, neither touched a type problem — the button named 自动修正
   * reported "未发现可自动修正的问题" over a document that could not be saved at all, which is the
   * behaviour the user reported and was right to doubt.
   *
   * So this repairs first and then reports. `repairConfigText` now coerces string spellings of the
   * flag fields back to booleans as well as handling syntax, so the common "cannot be saved" causes
   * are actually fixed rather than merely described.
   */
  const handleCheckAndFixRaw = () => {
    const repaired = repairConfigText(editorText);

    if (!repaired.ok) {
      // The text is not even readable, so there is nothing to repair. Say where the problem is and
      // leave the text alone — the user is looking at the editor and has to find it themselves.
      setRawStatus({
        tone: "error",
        message: describeRawIssue("检查未通过，需要手动修正", repaired.issue),
      });
      return;
    }

    const changed = repaired.text !== editorText;
    if (changed) {
      // The edit goes through the normal change path, so the debounced auto-save picks it up and the
      // repair lands without a second action.
      handleRawTextChange(repaired.text);
    }

    // Report on the text that will now be saved, so the message describes the state the user is left
    // in rather than the one they were in a moment ago.
    const after = parseConfigText(repaired.text, configBaseUrl);
    const issues = after.issues.length;
    const unusable = after.ok
      ? after.sources.filter((source) => !isTestableSource(source)).length
      : 0;
    const parts: string[] = [];
    parts.push(changed ? `已修正：${repaired.changes.join("、")}` : "没有可自动修正的问题");
    if (after.ok) {
      parts.push(
        `识别到 ${after.sources.length} 个源` +
          (after.liveCount > 0 ? `（其中直播源 ${after.liveCount} 个）` : "") +
          (unusable > 0 ? `，${unusable} 个没有可用适配器` : "，全部有可用适配器"),
      );
      if (issues > 0) parts.push(`另有 ${issues} 处需要留意`);
    } else {
      parts.push(`仍有无法解析的问题：${after.issues[0]?.message ?? "未知错误"}`);
    }

    setRawStatus({
      tone: !after.ok ? "error" : changed ? "success" : "info",
      message: `${parts.join("；")}。`,
    });
  };

  /**
   * Writes the editor's current text to the stored configuration.
   *
   * **There is no manual save.** The user asked for the text to land whether or not it is valid,
   * because a configuration is their own work and refusing to store it turns a typo into lost
   * effort. This used to refuse the save outright (`配置无法保存，请先修正`) and also refused anything
   * whose syntax JSON5 could not read, so a broken file could not even be saved in order to be fixed.
   *
   * The text always lands. `resolveSavePayload` decides what happens to the derived state: a
   * parseable text regenerates it, an unparseable one keeps the previous, so a typo never looks like
   * "all my sources are gone".
   *
   * The source list is merged from the *existing* records rather than replaced by the parse. That is
   * what preserves the user's own switches: an edited entry keeps its `enabled` and test state
   * because it is the same source by identity, while a deleted one has no counterpart and drops out.
   * Taking the parse directly would reset every switch each time a name was corrected.
   *
   * `options.silent` is for the debounced background save: it must not replace the status line the
   * user is currently reading with a "已保存" message on every keystroke.
   */
  const saveEditorText = async (
    text: string,
    options: { silent?: boolean } = {},
  ) => {
    // A save that already ran for this exact text must not run again.
    //
    // Without this the debounce re-fired after every write: a successful save merges the sources,
    // which changes `sources`, which the effect depends on, which restarts the timer and saves
    // again. Measured in a real browser, one field edit produced FIVE writes. A save loop is worse
    // than the manual save it replaced — it churns the database on an idle page, and each pass
    // re-parses and re-merges, which is how the source list grew duplicates.
    if (lastSavedText.current === text) return;

    const trimmed = text.trim();
    // `null` means "empty text", which is a state of its own rather than a parse failure — see
    // `resolveSavePayload`.
    const parsed = trimmed ? parseConfigText(text, configBaseUrl) : null;
    const payload = resolveSavePayload({
      text,
      parsed,
      previousSources: sources,
      previousNormalizedConfig:
        activeDocument?.normalizedConfig ?? normalizedConfig,
      previousLiveCount: activeDocument?.liveCount ?? sources.filter(
        (source) => source.sourceType === "live",
      ).length,
    });

    // Recorded before the await: a second call arriving while the first is still in flight must see
    // it, or two writes race and the later one may carry the older source list.
    lastSavedText.current = text;
    setIsSavingRaw(true);
    try {
      const name = activeDocument?.name ?? "中心配置";
      const saved = await replaceAllConfigDocuments({
        name,
        rawConfig: payload.rawConfig,
        normalizedConfig: payload.normalizedConfig,
        sources: payload.sources,
        liveCount: payload.liveCount,
        sourceBaseUrl: configBaseUrl ?? activeDocument?.sourceBaseUrl ?? null,
      });
      const document: StoredConfigDocument = saved ?? {
        id: activeConfigId ?? -Date.now(),
        name,
        rawConfig: payload.rawConfig,
        normalizedConfig: payload.normalizedConfig,
        sources: payload.sources,
        sourceCount: payload.sources.length,
        liveCount: payload.liveCount,
        importedAt: new Date().toISOString(),
        sourceBaseUrl: configBaseUrl ?? activeDocument?.sourceBaseUrl ?? null,
      };
      setConfigDocument(document);
      // The draft is dropped so the editors read the saved document again; keeping it would leave
      // the page showing text that no longer matches what is stored.
      setRawDraft(null);
      setRawStatus(
        payload.warning
          ? { tone: "error", message: payload.warning }
          : options.silent
            ? rawStatus
            : { tone: "success", message: `已自动保存：${payload.sourceCount} 个源。` },
      );
    } catch (error) {
      // The text did NOT land, so a retry must still be possible. Leaving the marker set would make
      // the guard skip every later attempt at the same text, turning one transient database error
      // into permanently unsaveable edits.
      lastSavedText.current = null;
      setRawStatus({
        tone: "error",
        message: `保存失败：${error instanceof Error ? error.message : "未知错误"}`,
      });
    } finally {
      setIsSavingRaw(false);
    }
  };

  /**
   * Whether the open document has edits that have not landed yet. */
  const hasRawChanges = rawDraft !== null && rawDraft !== rawConfig;

  /**
   * Reports a finished operation as a toast once the import dialog is out of the way.
   *
   * The page used to render this as a banner pinned below the list, where it stayed until the next
   * operation replaced it — a permanent record of a momentary event, in the space the list's own
   * footer belongs to. A toast says the same thing at the moment it happens and then leaves.
   *
   * `handledParseState` holds the exact state object already reported, so a message appears once.
   * While the dialog is open the message belongs beside the text being imported, so it is marked
   * handled without a toast — closing the dialog afterwards does not then repeat it.
   */
  const handledParseState = useRef<typeof parseState | null>(null);
  useEffect(() => {
    if (parseState.type === "idle") return;
    if (handledParseState.current === parseState) return;
    handledParseState.current = parseState;
    if (importOpen) return;
    toast({
      variant: parseState.type === "error" ? "error" : "success",
      // A caller-supplied title wins. Forcing "需要修正配置" onto every error meant a cancelled test
      // or a failed source audit announced itself as a broken configuration file, which is a
      // different problem entirely.
      title:
        parseState.title ??
        (parseState.type === "success" ? "解析完成" : "需要修正配置"),
      description: parseState.message,
    });
  }, [parseState, importOpen, toast]);

  /**
   * Auto-save, debounced.
   *
   * Every keystroke must not become a database write — a visual edit fires on blur, but the code
   * editor fires per character and rewriting the whole document (and the source list) on each one
   * would be both slow and a lot of churn for the SQLite writer. The delay is short enough that a
   * user who stops typing sees the change land before they can move on, and `hasRawChanges` going
   * false is the visible proof it did.
   *
   * Only a draft triggers it. `rawDraft === null` means the editors are showing the stored document,
   * so saving would be a no-op write that also bumps `importedAt`.
   */
  useEffect(() => {
    if (!hasRawChanges || isSavingRaw) return;
    const timer = window.setTimeout(() => {
      void saveEditorText(rawDraft ?? "", { silent: true });
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // `saveEditorText` is recreated each render, so depending on it would restart the timer on every
    // render and the save would never fire. The inputs it actually reads are listed instead.
    //
    // `sources` is deliberately NOT a dependency. It changes as a RESULT of a save (the merge
    // rewrites the list), so depending on it made every successful write schedule the next one —
    // measured, one edit produced five writes. The guard in `saveEditorText` is the second line of
    // defence; this is the first.
  }, [rawDraft, rawConfig, hasRawChanges, isSavingRaw, configBaseUrl, activeConfigId]);

  /**
   * Reports a failure to write the configuration, naming what actually failed.
   *
   * **A full browser store is not a configuration problem, and saying so was a lie the user had to
   * decode.** Measured on the reported 多仓 import: 54 addresses, 35 reachable, 11 real
   * configurations, merged to 602 sources. The store's own `partialize` over that document is
   * 695 KB against a 5120 KB quota — so the merged configuration is not the problem, and the
   * message `解析成功，但保存失败：... exceeded the quota` under the title `需要修正配置` sent the user
   * to look for a defect in a file that was fine.
   *
   * With `persist-storage.ts` in place the quota case no longer throws at all, so reaching here
   * means a genuine write failure. The title is still suppressed for the storage case in case an
   * older path or a browser we do not control raises it, because "需要修正配置" is the one thing it
   * certainly is not.
   */
  const saveParseError = (error: unknown) => {
    const message =
      error instanceof Error ? error.message : "本地数据库写入失败";
    const isStorage = isQuotaError(error) || /quota|exceeded/i.test(message);
    setParseState({
      type: "error",
      title: isStorage ? "浏览器存储已满" : undefined,
      message: isStorage
        ? `配置已保存到本地数据库，但浏览器的临时镜像写不进去（存储已满）。这不影响已导入的配置，可以继续使用；重启后本页的列表会从数据库重新读取。`
        : `解析成功，但保存失败：${message}`,
    });
  };

  const commitParsedConfig = async (
    result: ParseResult,
    options: { rawOverride?: string; successNote?: string } = {},
  ) => {
    const parsedCounts = countParsedCapabilities(result.sources);

    // The text to merge. Normally the editor's, but the 多仓 bulk path has already merged several
    // documents in memory and hands the result over here rather than routing it through the editor.
    const incomingText = options.rawOverride ?? importText;

    let mergedRawText = incomingText;
    let mergeReport: MergeReport | null = null;
    if (sources.length > 0 && rawConfig.trim()) {
      // Merging runs on the raw text, not on the parsed sources: the parsed model does not carry
      // every field a TVBox configuration can hold, and regenerating the file from it would discard
      // them silently.
      const existingRaw = parseRawObject(rawConfig);
      const incomingRaw = parseRawObject(
        JSON.stringify(
          absolutizeRelativeSites(
            parseRawObject(incomingText) ?? {},
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

    const name = activeDocument?.name || "中心配置";

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
      // A caller-supplied note wins: the 多仓 bulk path knows how many documents it merged and which
      // addresses failed, and that is more useful than the generic merge sentence.
      message:
        options.successNote ??
        (mergeReport
          ? `已合并进「${name}」：新增 ${sourceMerge.added} 个源，更新 ${sourceMerge.updated} 个，${sourceMerge.unchanged} 个原本就有；当前共 ${finalSources.length} 个源。`
          : `解析完成：${result.sources.length} 个影视源、${result.liveCount} 个直播源；可用 ${parsedCounts.supported} 个，${result.issues.length} 个需要关注。`),
    });
    setImportOpen(false);
  };

  const handleParse = async () => {
    setIsParsing(true);
    const result = parseConfigText(importText, configBaseUrl);

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
          {/* The merge result lives here rather than in a banner of its own.
              A whole card used to state "中心配置 · 355 个源 · 每次导入都会合并进来" above the tabs,
              which repeated the header's count and the sentence directly above it, and whose only
              other content was this summary. One line in the header says the same thing without a
              second row of chrome between the title and the work. */}
          {lastMergeSummary && (
            <span className="shrink-0 text-xs text-muted-foreground">
              上次合并：新增 {lastMergeSummary.added} · 更新 {lastMergeSummary.updated} · 已有{" "}
              {lastMergeSummary.unchanged}
            </span>
          )}
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

        {/* One configuration, stated once — in the header above. The switcher that used to live
            here existed because every import made a new document; now an import merges, so there is
            nothing to switch between, and the card that replaced it only repeated the header's
            count and its own sentence. */}

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as ConfigTab)}
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
                      /* Two controls, because "run the wider scope" and "let me choose a scope" are
                         different intents and a `Select` alone cannot express the first.
                         
                         Measured: a Radix `Select` does NOT fire `onValueChange` when the already
                         selected option is chosen again — correct for a picker, but it makes 全部测速
                         unreachable as a repeat action, which is the thing the user does most. So the
                         main button stays what it always was (one click runs 全部测速) and the caret
                         beside it opens the scope picker. Nothing is lost from the old behaviour and
                         the narrower scope is now expressible.

                         The seam between them is `ButtonGroup`'s job, not this file's. It used to be
                         hand-written — `rounded-r-none border-r-0` here, `rounded-l-none` there —
                         and that is the kind of geometry a hand-rolled version gets subtly wrong.
                         The registry's rule is
                         `has-[select[aria-hidden=true]:last-child]:[&>[data-slot=select-trigger]:last-of-type]:rounded-r-md`,
                         which exists because Radix renders a hidden native `<select>` AFTER the
                         trigger, so the trigger is not `:last-child` and a naive rule would leave
                         its right corners square. Adopting the component is what the user asked
                         for, and it also removed the manual corner and edge overrides. */
                      <ButtonGroup>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={testableSources.length === 0 || testingKeys.size > 0}
                          onClick={handleTestAll}
                        >
                          <FlaskConical
                            className="size-3.5"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          {`全部测速 (${testableSources.length})`}
                        </Button>
                        {/* **The official `ButtonGroup` pairing, not a `Select`.** The registry's own
                            example composes this control as `Button` + `DropdownMenu` with a
                            `ChevronDownIcon` trigger, and it was a `Select` here until the user
                            noticed the menu did not behave like the one on the site.

                            The difference is what the two primitives ARE. A `Select` is a picker: its
                            menu opens OVER the trigger (`item-aligned`), it shows a check mark beside
                            the current value, and re-choosing the current value fires nothing — so
                            "全部测速" was unreachable as a repeat action from the menu, which is why
                            this needed a separate always-clickable main button. A `DropdownMenu` is a
                            list of actions: it drops BELOW the trigger, and every item fires every
                            time, so both scopes are now ordinary, repeatable actions. That is the
                            shape the official example has, and it is why `ButtonGroup`'s own CSS
                            keys off `data-slot=select-trigger` only as a special case rather than as
                            the expected child.

                            **Why this was not the first choice, and what the measurement actually
                            says.** `docs/memory` recorded that a Radix `DropdownMenu` held open made a
                            25 ms timer take 24 766 ms, and that number was re-measured here before
                            adopting this: with the menu OPEN a 25 ms timer takes **25.0 ms**. The cost
                            is real but it is not the open state — it is jsdom plus popper positioning.
                            Measured three ways, three tests each: `Select` + `item-aligned` **193 ms**,
                            `Select` + `position="popper"` **53 183 ms**, `DropdownMenu` **51 775 ms**.
                            The gap lands BETWEEN tests (afterEach → next beforeEach), i.e. in
                            floating-ui's `autoUpdate` animation-frame loop outliving the test, and a
                            rAF stub does not remove it. So the price is a jsdom artifact of the
                            positioning engine, not something the shipped window pays; it is paid only
                            by tests that open this menu, which is why there is one such test and it
                            queries synchronously rather than through `findByRole` (measured: the menu
                            is in the DOM 76 ms after the key press, while an act-wrapped `findByRole`
                            on the same node did not return for 19.5 s).

                            No `SelectValue`/`SelectTrigger` hiding is needed any more, so the
                            `sr-only`-through-`data-slot` workaround that bug required is gone with it:
                            a `Button` renders exactly the children it is given. */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              aria-label="测速范围"
                              disabled={testableSources.length === 0 || testingKeys.size > 0}
                            >
                              <ChevronDown
                                className="size-3.5"
                                aria-hidden="true"
                              />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-56"
                            /* **Measured, not guessed: this is what makes the menu affordable to
                               test.** With collision avoidance on (the default), a test that opens
                               this menu costs jsdom **~19.5 s**; with it off, **~3.2 s** — five
                               consecutive opens measured 51 775 ms against 14 218 ms, and the cost
                               plateaus instead of compounding. The expensive middleware is `shift`
                               and `flip`, which walk every clipping ancestor to detect overflow —
                               work that is meaningless in jsdom's zero-layout tree, and pointless
                               here regardless: this menu hangs off a toolbar with the entire source
                               list below it, so there is nothing to avoid colliding with. The `size`
                               middleware stays on (it is not gated by this prop), so the
                               `--radix-popper-available-height` cap still applies.

                               Note what this does NOT do: it does not change where the menu opens.
                               `align="end"` and the popper default side still put it below the
                               caret, flush to the right edge — which is the visible difference the
                               user reported, since the `Select` this replaced opened its menu OVER
                               the trigger. */
                            avoidCollisions={false}
                          >
                            <DropdownMenuItem
                              onSelect={() => {
                                handleTestAll();
                              }}
                            >
                              <FlaskConical className="size-3.5" aria-hidden="true" />
                              {`全部测速（${testableSources.length}）`}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={untestedSources.length === 0}
                              onSelect={() => {
                                handleTestUntested();
                              }}
                            >
                              <TestTube2 className="size-3.5" aria-hidden="true" />
                              {`只测未测过的（${untestedSources.length}）`}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </ButtonGroup>
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
                        sources, no removable row is on screen and the button does not appear.

                        Disabled while any test is in flight, and kept on screen rather than hidden.
                        A running test is what CREATES removable sources — every failure switches a
                        source off and adds it to this count — so mid-run the label counts up under
                        the cursor and the set behind it is still changing. Clicking then means
                        confirming a deletion whose size and contents the user never saw. The guard is
                        the same `testingKeys` the 测速 button beside it uses, so a single row's test
                        disables both rather than leaving this one live while its neighbour is not. It
                        stays visible so the toolbar does not reflow as the run proceeds.

                        The `title` sits on the wrapping span, not on the button, because a disabled
                        `Button` carries `disabled:pointer-events-none`: it is never the hover target,
                        so a `title` on the button itself would be markup that can never be read. */}
                    {bulkRemovableSources.length > 0 && (
                      <span
                        title={
                          testingKeys.size > 0
                            ? "测速进行中，结果仍在变化；测速结束后再清理。"
                            : undefined
                        }
                      >
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5 text-muted-foreground hover:text-destructive"
                          disabled={testingKeys.size > 0}
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
                      </span>
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
                  <SourceTable
                    sources={filteredSources}
                    testingKeys={testingKeys}
                    removableKeys={removableKeys}
                    isBatchTesting={isBatchTesting}
                    onInspect={setInspectedSourceKey}
                    onToggleSource={handleToggleSource}
                    onTestSource={handleTestSource}
                    onCancelTestSource={handleCancelTestSource}
                    onCancelTestAll={handleCancelTestAll}
                    onRemoveSources={handleRemoveSources}
                  />
                ) : (
                  /* Padded to match the table's own inset: the card's content area has no
                     padding (the table brings its own), so an empty state flush against it
                     pressed its dashed border against the card edge.
                     The wrapper is also a flex column that takes the remaining height, and that is
                     load-bearing: `Empty` carries `flex-1`, but inside a plain block `flex-1` does
                     nothing, so the dashed border stopped wherever its own content ended and left a
                     gap above the card's bottom edge. */
                  <div className="flex min-h-0 flex-1 flex-col p-4">
                    <Empty>
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
                        {/* The three words come from the registry rather than being typed here.
                            They were written out a fourth time, which is how the panel, the adapter
                            column and this dropdown could each say something different about one
                            source. */}
                        {(["enabled", "needs-adapter", "blocked"] as const).map(
                          (execution) => (
                            <SelectItem key={execution} value={execution}>
                              {adapterStatusLabel(execution)}
                              <span className="ml-auto pl-3 tabular-nums text-muted-foreground">
                                {adapterStateCounts[execution]}
                              </span>
                            </SelectItem>
                          ),
                        )}
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
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Code2 className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                      原始配置
                    </CardTitle>
                    <CardDescription>
                      {rawMode === "visual"
                        ? "以列表方式管理配置里的源与设置，改动会立刻写回配置文本。"
                        : "直接编辑配置文本；改动会写回配置，切回可视化模式即可查看。"}
                    </CardDescription>
                  </div>
                  {/* Two modes over one document rather than two editors: the text stays the
                      source of truth, and switching views never copies or converts anything. */}
                  <div className="flex shrink-0 items-center gap-2">
                    <Tabs
                      value={rawMode}
                      onValueChange={(value) => setRawMode(value as RawMode)}
                    >
                      <TabsList>
                        <TabsTrigger value="visual" className="gap-1.5">
                          <ListTree className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                          可视化
                        </TabsTrigger>
                        <TabsTrigger value="code" className="gap-1.5">
                          <Braces className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                          代码
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                    {rawMode === "code" && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={!editorText.trim()}
                          onClick={handleFormatRaw}
                        >
                          <AlignLeft className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                          格式化
                        </Button>
                        {/* One button, not two.
                            校验 and 自动修正 were separate actions over the same text, and 校验 only
                            ever reported what 自动修正 could then have fixed — so the pair made the
                            user do the diagnosis themselves and press twice for one outcome. The
                            merged action repairs what it can and then reports what is left, which is
                            both halves in the order they are useful. */}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={!editorText.trim()}
                          onClick={handleCheckAndFixRaw}
                        >
                          <WandSparkles className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                          检查并修正
                        </Button>
                      </>
                    )}
                    {/* No save button: edits save themselves. What the user needs from this corner is
                        not an action but the state — whether their text has landed, and whether the
                        app could read it. It is a status, not a control, which is also why it can no
                        longer be pressed at the wrong moment. */}
                    <span
                      role="status"
                      aria-label="自动保存状态"
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      {isSavingRaw ? (
                        <>
                          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                          正在保存…
                        </>
                      ) : hasRawChanges ? (
                        <>
                          <Save className="size-3.5" aria-hidden="true" />
                          等待自动保存…
                        </>
                      ) : (
                        <>
                          <Check className="size-3.5" aria-hidden="true" />
                          已自动保存
                        </>
                      )}
                    </span>
                  </div>
                </div>
              </CardHeader>
              {/* The editor takes the remaining height instead of a fixed 680px. A fixed height
                  made the card 938px tall in an 805px window, and since the page itself is
                  overflow-hidden the bottom of the editor — and the last lines of the
                  configuration — could not be reached at all. */}
              {/* No padding of its own. Every tab's content is inset by the element that owns the
                  inset, so the four tabs agree: controls and block edges at 16px (the card header's
                  own `px-4`), and the text inside a bordered list row at 24px, which is where the
                  table tabs' `pl-6` puts theirs. The arbitrary 12px here and 20px in 解析报告 were
                  the whole of the inconsistency — measured, not guessed. */}
              <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                {rawMode === "visual" ? (
                  <ConfigVisualEditor
                    value={editorText}
                    onChange={handleRawTextChange}
                    sources={sources}
                  />
                ) : (
                  <JsonEditor
                    value={editorText}
                    onChange={handleRawTextChange}
                    aria-label="原始配置文本"
                    className="min-h-0 flex-1"
                  />
                )}
              </CardContent>
              {/* One report, shared by both modes: a parse failure is a property of the document,
                  not of the view it was found in. */}
              {rawStatus && (
                <div className="shrink-0 border-t border-border/60 px-3 py-2.5">
                  <div
                    role="status"
                    aria-label="配置检查结果"
                    className={cn(
                      "flex items-start gap-2 rounded-md p-2.5 text-xs leading-5",
                      rawStatus.tone === "error"
                        ? "border border-destructive/40 bg-destructive/10 text-destructive"
                        : rawStatus.tone === "success"
                          ? "border border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]"
                          : "border border-border/60 bg-muted/30 text-muted-foreground",
                    )}
                  >
                    {rawStatus.tone === "error" ? (
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span>{rawStatus.message}</span>
                  </div>
                </div>
              )}
            </Card>
          </TabsContent>
        </Tabs>

        {/* The page-level banner is gone: every message it carried is now a toast.
            
            It sat at the bottom of the page and stayed there, so a finished import kept announcing
            itself until the next operation replaced it — a permanent record of a momentary event,
            occupying the space where the source list's own footer belongs. A toast says the same
            thing at the moment it happens and then leaves. The in-dialog copy below is unchanged:
            while the import dialog is open, its message belongs beside the text being imported. */}
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
            {/* No 配置名称 field: an import merges into 中心配置, so the name the user typed was
                discarded immediately — the document keeps the centre configuration's own name. Asking
                for a value that cannot be used is worse than not asking: it implies the import
                creates something separate, which is exactly the model this page removed. */}
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

            {/* A 多仓 address lists OTHER configurations rather than being one. Rendering the list is
                the whole reason for recognising the shape: the user wanted one of these, and asking
                them to copy it out of the JSON by hand is the alternative. */}
            {multiRepo && (
              <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-md border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    这份列表来自 {multiRepo.from}，共 {multiRepo.entries.length} 个配置。
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    {/* One button for the whole list. Eighteen addresses is eighteen trips through
                        this dialog otherwise, and the editor holds one document at a time, so
                        "import them all" was not expressible before. */}
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1.5"
                      disabled={isImportingAll}
                      onClick={() => void handleImportAllMultiRepo()}
                    >
                      {isImportingAll ? (
                        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Download className="size-3.5" aria-hidden="true" />
                      )}
                      {isImportingAll ? "合并中…" : `全部合并导入 (${multiRepo.entries.length})`}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      disabled={isImportingAll}
                      onClick={() => setMultiRepo(null)}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                      关闭
                    </Button>
                  </div>
                </div>
                {/* What the batch is doing, as it does it.
                    
                    The loop is sequential across eighteen hosts, so without this the only sign of life
                    was a button reading "合并中…" — indistinguishable from a freeze when one host is
                    slow. The bar is deliberately indeterminate-looking while the count moves: the
                    count is the information, and a percentage would imply a predictable speed these
                    hosts do not have. */}
                {importProgress && (
                  <div
                    role="status"
                    aria-label="批量导入进度"
                    className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-background px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate text-muted-foreground">
                        正在取回「{importProgress.current}」
                      </span>
                      <span className="shrink-0 tabular-nums text-foreground">
                        {importProgress.done} / {importProgress.total}
                      </span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-200"
                        style={{
                          width: `${Math.round((importProgress.done / Math.max(1, importProgress.total)) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
                <ScrollArea className="min-h-0 flex-1 rounded-md border bg-background">
                  <div className="flex flex-col">
                    {multiRepo.entries.map((entry) => (
                      <button
                        key={`${entry.name}|${entry.url}`}
                        type="button"
                        onClick={() => void handlePickMultiRepo(entry.url)}
                        className="flex flex-col gap-0.5 border-b border-border/60 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-accent/40"
                      >
                        <span className="text-sm text-foreground">{entry.name}</span>
                        <span className="break-all font-mono text-[11px] text-muted-foreground">
                          {entry.url}
                        </span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
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
                    ，不是只在这里隐藏。这个源会从当前配置里移除。
                  </li>
                  {/* This used to say "之后重新导入同一份配置，这些源不会回来", which was never true
                      after imports became a merge. Removing a source drops it from this
                      configuration and records nothing about the source being unwanted, so a later
                      import that contains it adds it back as a new source. That is the behaviour a
                      user wants — prune one configuration's clutter, then import a different file
                      that legitimately carries the same source — so the sentence is corrected
                      rather than the behaviour. */}
                  <li>
                    以后导入的文件里如果还有这个源，它会作为新源重新加回来。
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
              disabled={isRemoving}
              onClick={() => setRemoveRequest(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="gap-1.5"
              disabled={isRemoving}
              onClick={() => void confirmRemoveSources()}
            >
              {isRemoving && (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              )}
              {isRemoving ? "正在删除…" : "确认删除"}
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
                      hasScriptArchive(inspectedSource)) && (
                      <DetailSection title="本地脚本绑定">
                        <div className="rounded-lg border border-border/70 bg-card/40 p-3 text-xs leading-5 text-muted-foreground">
                          绑定后只会调用本地档案；远程 JS、JAR 和 Spider
                          仍不会自动执行。
                        </div>
                        {hasScriptArchive(inspectedSource) && (
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
        {/* Only where the script address is the thing in question. For a source blocked by a JAR or
            by a spider runtime, checking a script address would answer a question nobody asked. */}
        {(adapter.id === "drpy-js" || adapter.id === "js-extension") && (
          <ScriptAddressCheck source={source} />
        )}
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
 * Checks whether this source's script address can actually be fetched.
 *
 * **This exists because "blocked" was hiding four different situations under one sentence.** A
 * script that 404s, a host that refuses the request, one that exists but needs a host API layer the
 * sandbox does not provide, and one that is not a script at all were all reported as a missing
 * sandbox. Measured on the author's configuration, 9 of the 10 distinct addresses are unusable and
 * 2 of those are a host refusing rather than a file missing — so the reader could not tell which of
 * their sources were worth keeping.
 *
 * It runs on demand rather than automatically: it makes a request to a third-party host, which is
 * not something to do behind the user's back while they scroll a list of 355 sources.
 */
function ScriptAddressCheck({ source }: { source: SourceRecord }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "done"; probe: ScriptAddressProbe }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });

  const run = async () => {
    setState({ kind: "checking" });
    try {
      const probe = await probeScriptAddress(source.api);
      if (!probe) {
        // Browser preview: the command is not registered there, and saying so is better than
        // showing a spinner that never resolves.
        setState({
          kind: "failed",
          message: "浏览器预览不会请求外部地址，请在桌面应用中检测。",
        });
        return;
      }
      setState({ kind: "done", probe });
    } catch (error) {
      setState({
        kind: "failed",
        message: error instanceof Error ? error.message : "检测失败",
      });
    }
  };

  const tone =
    state.kind === "done"
      ? state.probe.verdict === "reachable"
        ? "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]"
        : "border-[color:var(--status-partial-border)] bg-[color:var(--status-partial-bg)] text-[color:var(--status-partial)]"
      : "border-border/60 bg-muted/20 text-muted-foreground";

  return (
    <div className="flex flex-col gap-2 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground/70">脚本地址</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          disabled={state.kind === "checking" || !source.api.trim()}
          onClick={() => void run()}
        >
          {state.kind === "checking" ? (
            <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
          ) : (
            <Search className="size-3" aria-hidden="true" />
          )}
          检测脚本地址
        </Button>
      </div>

      <p className="break-all font-mono text-[11px] leading-5 text-muted-foreground">
        {source.api || "（未填写）"}
      </p>

      {state.kind === "done" && (
        <div
          role="status"
          className={cn("rounded-md border p-2.5 text-xs leading-5", tone)}
        >
          <p>{state.probe.message}</p>
          {/* The mirror is offered as an address to look at, not applied silently: rewriting a
              third-party source's address is the user's decision, and the value is worth seeing. */}
          {state.probe.mirrorUrl && (
            <div className="mt-2 border-t border-current/20 pt-2">
              <p>{state.probe.mirrorReason}</p>
              <p className="mt-1 break-all font-mono text-[11px]">
                {state.probe.mirrorUrl}
              </p>
            </div>
          )}
        </div>
      )}

      {state.kind === "failed" && (
        <div
          role="status"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs leading-5 text-destructive"
        >
          {state.message}
        </div>
      )}
    </div>
  );
}

/**
 * A small icon that says whether this source can be run, and why not.
 *
 * It replaces the words 可执行 / 未适配, which wrapped onto a second line and read as a status report
 * rather than as a property of the source.
 *
 * **The three states are not two.** The icon used to be a plain "adapter exists / does not", which
 * contradicted the status column beside it: a source whose record is missing its address shows
 * 配置无效 in one column and a green tick here, and hovering it says 没有可用适配器 — so the reader
 * is told simultaneously that there is no adapter and that the reason is the record. Both are true,
 * and neither is the whole answer. The third state names the actual cause: the adapter exists and
 * the record is what is unusable.
 */
function AdapterPresenceBadge({ source }: { source: SourceRecord }) {
  const testable = isTestableSource(source);
  // A record the parser could not build is rejected before the adapter is even consulted, so the
  // adapter's existence is beside the point: no request can be constructed from it.
  const recordUnusable = source.capability === "invalid";

  const state = testable ? "ready" : recordUnusable ? "record" : "missing";
  const config = {
    ready: {
      Icon: CircleCheck,
      label: "已有适配器",
      detail: "已有适配器，可以测试。",
      className:
        "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
    },
    record: {
      Icon: CircleAlert,
      label: "配置无效",
      // The adapter's existence is stated as well, because that is the half the green tick was
      // reporting: it is real, and it is not what is stopping this source.
      detail: `适配器可用（${getAdapterProfile(source).label}），但这条配置缺少必要字段，无法构造请求。`,
      className:
        "border-destructive/40 bg-destructive/10 text-destructive",
    },
    missing: {
      Icon: CircleX,
      label: "没有可用适配器",
      // "不可运行" rather than "没有可执行" — the latter contains the word the status column uses to
      // mean the opposite, so a reader (and a test) could not tell which claim was being made.
      detail: `该源没有可运行的适配器（${getAdapterProfile(source).label}）。`,
      className:
        "border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)] text-[color:var(--status-blocked)]",
    },
  }[state];

  return (
    <Badge
      variant="outline"
      className={cn(
        "size-5 shrink-0 justify-center rounded-full p-0",
        config.className,
      )}
      title={config.detail}
    >
      <config.Icon className="size-3" aria-hidden="true" />
      <span className="sr-only">{config.detail}</span>
    </Badge>
  );
}

function SourceStatusBadge({ source }: { source: SourceRecord }) {
  // The status column answers "where does this source stand". For a source with no runnable
  // adapter the answer is the adapter's own verdict, not the capability the parser recorded at
  // import time: those are two different questions, and asking the wrong one is what produced a row
  // reading 部分支持 beside an adapter badge reading 没有可用适配器. `AdapterStatusBadge` renders
  // 无法适配 / 已阻止, which is the same word the adapter column uses, so the two can never disagree.
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
    // One word for every failure. It used to distinguish 连接失败 from 测试失败, because only the
    // second switched the source off; now both do, so a second word would name a distinction that
    // nothing acts on.
    failed: { label: "测试失败", tone: "blocked" },
    // `blocked` means the test could not run, not that the source is bad — the backend returns it
    // when the adapter refuses. It read 不可用 here while the 连接测试 column beside it read 已阻止,
    // so one row described one state two ways. Both now say 未执行, which is what happened.
    blocked: { label: "未执行", tone: "needs-adapter" },
  };
  const { label, tone } = display[status];
  return <CapabilityBadge status={tone} label={label} />;
}

function SourceTestBadge({ source }: { source: SourceRecord }) {
  // A source with no runnable adapter cannot be tested at all, so 未测试 would imply the user has
  // simply not got round to it. The visual editor already distinguishes the two — 配置无效 and
  // 无法测试 — and this column was still claiming a pending test for a row the 状态 column beside it
  // had just called 已阻止 or 无法适配.
  if (!isTestableSource(source)) {
    const invalid = source.capability === "invalid";
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldAlert className="size-3.5" data-icon="inline-start" aria-hidden="true" />
        <span>{invalid ? "配置无效" : "无法测试"}</span>
      </div>
    );
  }

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
      // One word for every failure, as in the 状态 column: both kinds switch the source off now, so
      // distinguishing 连不上 from 请求失败 would name a difference nothing acts on.
      label: "请求失败",
      className: "text-[color:var(--status-blocked)]",
      icon: CircleX,
    },
    // Matches the 状态 column's word for the same state. It said 已阻止 here, which is also the
    // adapter registry's word for a different thing (an adapter that refuses to run at all), so the
    // same three characters named two unrelated conditions on one screen.
    blocked: {
      label: "未执行",
      className: "text-[color:var(--status-partial)]",
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

/**
 * The source list.
 *
 * Extracted and memoised for one measured reason: typing in the import dialog re-rendered every row
 * of this table. The dialog's text lives in `ConfigCenter`, so each keystroke re-rendered the whole
 * page — 358 rows, 18,622 DOM nodes. Measured in a browser on the owner's configuration, one
 * keystroke cost a median of 30 ms with the full table mounted and 7 ms with it filtered to a single
 * row: same dialog, same document in the editor. Nothing about the editor was slow.
 *
 * `memo` only helps because every prop is referentially stable — `filteredSources` was already a
 * `useMemo`, and the handlers are `useCallback`s over store actions and setters.
 */
const SourceTable = memo(function SourceTable({
  sources,
  testingKeys,
  removableKeys,
  isBatchTesting,
  onInspect,
  onToggleSource,
  onTestSource,
  onCancelTestSource,
  onCancelTestAll,
  onRemoveSources,
}: {
  sources: SourceRecord[];
  testingKeys: Set<string>;
  removableKeys: Set<string>;
  isBatchTesting: boolean;
  onInspect: (key: string) => void;
  onToggleSource: (key: string) => void;
  onTestSource: (source: SourceRecord) => void;
  onCancelTestSource: (key: string) => void;
  onCancelTestAll: () => void;
  onRemoveSources: (
    keys: string[],
    description: string,
    options: { needsConfirmation: boolean },
  ) => void;
}) {
  /**
   * Virtualised, because mounting every row is what made the dialog stall.
   *
   * Measured in a browser on the owner's configuration: opening the import dialog blocked the main
   * thread for 269 ms and closing it for 100 ms + 144 ms, with 358 rows and 18,623 DOM nodes — and
   * filtering the same table to one row dropped both to 22 ms and 7 ms with no long task at all. The
   * cost is mounting and unmounting this table's DOM tree, which `memo` cannot help with: the dialog
   * opening mounts the table regardless. Only not mounting the off-screen rows does.
   */
  const viewportRef = useRef<HTMLDivElement>(null);
  const canMeasure = useMemo(() => hasLayoutEngine(), []);
  const virtualizer = useVirtualizer({
    count: sources.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => SOURCE_ROW_HEIGHT,
    // A little past the visible edge, so a fast scroll does not reveal blank rows.
    overscan: 8,
    // The starting estimate matters: with no viewport the first render would fall back to rendering
    // every row, which is the stall this removes, paid once per open.
    initialRect: { width: 0, height: INITIAL_VIEWPORT_HEIGHT },
    // Measurement is skipped only where it is impossible. Where it works it is what keeps a row that
    // is taller than the estimate from overlapping the next one.
    enabled: canMeasure,
  });

  const virtualItems = canMeasure ? virtualizer.getVirtualItems() : [];
  const { virtualize, paddingTop, paddingBottom } = resolveVisibleRows({
    rowCount: sources.length,
    viewportHeight: canMeasure ? (viewportRef.current?.clientHeight ?? INITIAL_VIEWPORT_HEIGHT) : 0,
    virtualItems,
    totalSize: virtualizer.getTotalSize(),
  });
  // When virtualising, the window is a contiguous range, so it can be sliced directly rather than
  // looked up per index.
  const rows = virtualize
    ? sources.slice(virtualItems[0].index, virtualItems[virtualItems.length - 1].index + 1)
    : sources;

  const renderRow = (source: SourceRecord) => {
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
              onClick={() => onInspect(source.key)}
            >
              <TableCell className="pl-6">
                <div className="flex items-center gap-3">
                  {/* `shrink-0`, and it is load-bearing rather than tidiness. This is a flex item
                      whose sibling holds a source address, and the sibling carries `min-w-0` so it
                      can absorb the squeeze. Without `shrink-0` the icon absorbs it too: `size-8`
                      fixes width and height, but flex items default to `flex-shrink: 1`, so the box
                      keeps its 32px height while its width collapses — the flattened icon the user
                      reported. It showed on SOME rows because only rows whose address is long
                      enough to overflow the column exert the pressure. */}
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
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
                    {/* The second line used to read `{source.key} · 直播源`, which put
                        the configuration author's own identifier in front of the
                        reader. Measured on the owner's file: three live sources carry
                        the keys `-7`, `-8` and `-9`, and no one can tell what those
                        mean — they are array indices the publisher invented. The
                        address is what actually identifies a source to a person, so
                        that is what this shows, with the kind as the fallback when
                        there is no address. */}
                    <p className="truncate text-xs text-muted-foreground">
                      {source.api?.trim() ||
                        (source.sourceType === "cms"
                          ? "普通 CMS"
                          : source.sourceType === "live"
                            ? "直播源"
                            : "解析服务")}
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
                      void onToggleSource(source.key)
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
                          void onTestSource(source);
                          return;
                        }
                        // A row that is busy because a batch owns it cancels the
                        // batch: that is the operation the user is waiting on, and
                        // stopping only this row would leave the rest running with no
                        // way to stop them from here.
                        if (isBatchTesting) {
                          onCancelTestAll();
                          return;
                        }
                        onCancelTestSource(source.key);
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
                    onRemoveSources(
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
  };

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
      {/* `table-fixed`, and this is a virtualisation requirement rather than a style choice.
          
          Measured before it: with the default `table-layout: auto` the browser derives column widths
          from the cells it can see, and virtualisation changes which rows those are as you scroll, so
          the columns slid sideways under the cursor. Measured across six scroll positions, the first
          column's width went 494 → 333 → 348 → 559 → 333 → 532px and the second column's left edge
          moved 679 → 518 → 533 → 744 → 518 → 717px. The widths are now declared once and do not
          depend on which rows are mounted.
          
          The explicit widths also replace what `auto` was inferring: the name column takes the
          remaining space, and the four narrow ones are sized to their content — the switch, the two
          icon buttons and the two-word headings. */}
      <Table containerClassName="overflow-visible" className="table-fixed">
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[30%] pl-6">资源名称</TableHead>
            <TableHead className="w-[13%]">状态</TableHead>
            <TableHead className="w-[22%]">适配器</TableHead>
            <TableHead className="w-[15%]">连接测试</TableHead>
            <TableHead className="w-16 text-center">启用</TableHead>
            <TableHead className="w-20 pr-6 text-center">
              操作
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* The rows that are not mounted are represented by spacers rather than dropped, so the
              scrollbar describes the whole list instead of only the window. A spacer row is used
              rather than padding on the body because padding on a `tbody` is not laid out
              consistently across browsers. */}
          {virtualize && paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={6} style={{ height: paddingTop, padding: 0, border: 0 }} />
            </tr>
          )}
          {rows.map(renderRow)}
          {virtualize && paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={6} style={{ height: paddingBottom, padding: 0, border: 0 }} />
            </tr>
          )}
        </TableBody>
      </Table>
      <ScrollBar />
    </ScrollArea>
  );
});
