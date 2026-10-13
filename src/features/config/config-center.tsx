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
  Check,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Download,
  FileJson,
  FileUp,
  FlaskConical,
  Globe2,
  Info,
  LoaderCircle,
  Search,
  ShieldAlert,
  TestTube2,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { useToast } from "@/components/toast-host";
import { locateVisualEntry, updateVisualEntryField } from "@/features/config/config-visual";
import type { VisualField, VisualSectionKey } from "@/features/config/config-visual";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { SearchInput } from "@/components/search-input";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  readExportExtras,
  stripExportExtras,
} from "@/features/config/config-extras";
import { buildExportConfigText } from "@/features/config/config-export";
import {
  IMPORT_KIND_LABELS,
  buildImportPreview,
  keepSelectedEntries,
  type ImportCandidate,
  type ImportPreview,
} from "@/features/config/config-import-preview";
import {
  absolutizeRelativeSites,
  mergeRawConfigs,
  mergeSourceLists,
  type MergeReport,
} from "@/features/config/config-merge";
import {
  countParsedCapabilities,
  parseConfigText,
  parseRawObject,
  pruneUnsupportedConfigText,
  repairConfigText,
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
  adapterStatusLabel,
  getAdapterProfile,
  isPermanentlyUnsupportedSource,
  isTestableSource,
  type AdapterExecution,
} from "@/lib/adapters";
import { cn, errorMessage } from "@/lib/utils";
import {
  activateConfigDocument,
  cancelSourceTest,
  clearAllConfigDocuments,
  exportConfigFile,
  fetchConfigUrl,
  forgetSourceTestRun,
  isTauriRuntime,
  loadActiveConfig,
  recoverKnownLiveSources,
  replaceAllConfigDocuments,
  setConfigSourceBaseUrl,
  testSource,
  updateSourceTest,
  type StoredConfigDocument,
} from "@/lib/tauri";
import { useAppStore } from "@/stores/app-store";
import { isQuotaError } from "@/stores/persist-storage";
import type {
  CapabilityStatus,
  SourceDialect,
  SourceOperationStatus,
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

/**
 * How long the editor waits after the last keystroke before writing.
 *
 * Long enough that typing a key does not trigger a write, short enough that a pause reads as
 * "saved". The status line updates the moment it lands, so the value is not load-bearing.
 *
 * The editor itself is gone — 原始配置 was removed — but this delay is still what the drawer's field
 * edits are written on, through the same debounced save they always used.
 */
const AUTO_SAVE_DELAY_MS = 600;

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
  const toggleSource = useAppStore((state) => state.toggleSource);
  const removeSources = useAppStore((state) => state.removeSources);
  const setConfigDocument = useAppStore((state) => state.setConfigDocument);
  const setSourceTestResult = useAppStore((state) => state.setSourceTestResult);
  const setConfigDocuments = useAppStore((state) => state.setConfigDocuments);
  const clearConfigDocument = useAppStore((state) => state.clearConfigDocument);
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
  // Favourites and the theme no longer travel in an export — 设置 owns 软件数据 now — but the store
  // actions stay: an older export still carries a `moseek` key, and reading it is how a user who
  // exported before the split gets their favourites back.
  const setTheme = useAppStore((state) => state.setTheme);
  const restoreFavorites = useAppStore((state) => state.restoreFavorites);
  const [inspectedSourceKey, setInspectedSourceKey] = useState<string | null>(
    null,
  );
  const [importOpen, setImportOpen] = useState(false);
  /**
   * The configuration text an import would commit.
   *
   * Still the buffer every path writes into — remote fetch, file drop, paste — but no longer shown to
   * the user: the dialog renders `importPreview` instead, because a JSON editor is not a choice anyone
   * can make who does not already read JSON.
   */
  const [importText, setImportText] = useState("");
  /**
   * What the current text contains, in the form the user picks from.
   *
   * Derived rather than stored: it is a pure function of the text, kept in state only so the id of the
   * selected entries survives a re-render. Recomputing on every keystroke is fine — the text only
   * changes when a file or an address arrives.
   */
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  /**
   * Which entries the user unticked, by candidate id.
   *
   * **Holds the DESELECTED ones, not the selected ones.** A new import has everything ticked, so an
   * empty set is the correct starting state and there is no moment where a fresh file appears with
   * nothing selected. Storing the complement would need every import to enumerate the whole file up
   * front, and a bug there silently imports nothing.
   */
  const [deselectedEntryIds, setDeselectedEntryIds] = useState<Set<string>>(new Set());
  /**
   * Which groups the user has collapsed.
   *
   * All open on arrival, because the file has just been read and the list is the answer to "what is in
   * it". The control exists for the case the user reported: a configuration with 130 解析服务 makes the
   * group they actually care about a scroll away.
   */
  const [collapsedImportKinds, setCollapsedImportKinds] = useState<Set<ImportCandidate["kind"]>>(
    new Set(),
  );
  /**
   * Whether the import dialog is open, readable from an effect without making it a dependency.
   *
   * The document-reset effect has to know this, and depending on `importOpen` directly would re-run it
   * on every open and close — which is precisely the reset it is being asked to skip.
   */
  const importOpenRef = useRef(false);
  importOpenRef.current = importOpen;
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  /**
   * Whether a write is in flight, so the debounce cannot start a second one over the top of it.
   *
   * No visible control reads this any more — the status line it used to drive lived in 原始配置 —
   * but it is still load-bearing: it is the first of the two guards that keep one edit from becoming
   * five writes.
   */
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
  /**
   * Releases the running batch when the user cancels. Held in a ref so the row-level cancel
   * buttons and the toolbar button all reach the same in-flight run.
   */
  const cancelRunRef = useRef<(() => void) | null>(null);
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
  const latestEditorText = useRef(editorText);
  latestEditorText.current = editorText;
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
  /**
   * The entry in the configuration text that the inspected source came from, and the section it is in.
   *
   * **Computed from the text, not remembered from an index.** An index would go stale the moment
   * anything else edited the document, and a stale index writes one source's fields into another's
   * row. `locateVisualEntry` returns null when it cannot be certain — a duplicate address with no key
   * to separate them, a Kitty-shaped document whose entries live under `data`, or an address the file
   * does not contain — and the drawer then offers no fields rather than a form that would corrupt the
   * file.
   *
   * **Only `sites` and `lives` are reachable, and that is not an omission.** The parser emits nothing
   * else: `classifySource` writes `"cms"` and `classifyLiveSource` writes `"live"`, and 解析服务 are
   * parsed into a separate `parseServices` list that never enters `sources`. `adapters.ts` records the
   * same fact — its `"parser"` branch has had no producer since `da8f565`.
   *
   * This is what replaced the 原始配置 tab: the drawer is where a user acts on one source, so this is
   * where its fields belong.
   */
  const inspectedEntry = useMemo(() => {
    if (!inspectedSource || !editorText.trim()) return null;
    // Narrowed to the two the parser can emit, so the type is what the code can actually be handed.
    const section: VisualSectionKey =
      inspectedSource.sourceType === "live" ? "lives" : "sites";
    const entry = locateVisualEntry(editorText, section, {
      key: inspectedSource.key,
      api: inspectedSource.api,
    });
    return entry ? { section, entry } : null;
  }, [inspectedSource, editorText]);
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

  useEffect(() => {
    const sourceBaseUrl = activeDocument?.sourceBaseUrl ?? undefined;
    setConfigBaseUrl(sourceBaseUrl);
    setSourceBaseUrlDraft(sourceBaseUrl ?? "");
  }, [activeDocument?.id, activeDocument?.sourceBaseUrl]);

  /**
   * Loads text into the dialog and builds its preview in the same step.
   *
   * **The preview is built here rather than in an effect on `importText`, and that is the fix for a real
   * race.** An effect made the two values independent: a document-reset effect fires on `rawConfig`
   * changing, and it can land between `setImportText(newText)` and the preview effect that was queued
   * against the OLD text. Measured in a test that imports a two-source file over a document that already
   * held one: the dialog listed one source, the commit button read 导入 1 个资源, and pressing it
   * imported a file the user had never chosen. Building both together makes that ordering impossible —
   * there is no window in which one has moved and the other has not.
   */
  const loadImportText = useCallback((text: string, baseUrl: string | null) => {
    setImportText(text);
    const preview = text.trim() ? buildImportPreview(text, baseUrl) : null;
    setImportPreview(preview);
    // **Neither an unusable entry nor a repeat starts ticked**, and neither can be ticked — see the
    // list component. Seeding the deselected set here rather than filtering at commit time means the
    // count on the button, the number in each group heading, and the file that gets written are all
    // derived from one fact.
    setDeselectedEntryIds(
      new Set(
        (preview?.candidates ?? [])
          .filter((candidate) => !candidate.usable || candidate.duplicate)
          .map((candidate) => candidate.id),
      ),
    );
    setCollapsedImportKinds(new Set());
  }, []);

  /** The ids of the entries the user is keeping. */
  const selectedEntryIds = useMemo(() => {
    if (!importPreview) return new Set<string>();
    return new Set(
      importPreview.candidates
        .filter((candidate) => !deselectedEntryIds.has(candidate.id))
        .map((candidate) => candidate.id),
    );
  }, [importPreview, deselectedEntryIds]);

  const toggleEntry = useCallback((id: string, next: boolean) => {
    setDeselectedEntryIds((current) => {
      const updated = new Set(current);
      if (next) updated.delete(id);
      else updated.add(id);
      return updated;
    });
  }, []);

  /**
   * Ticks or unticks a whole group.
   *
   * **Only the entries this control can act on are touched.** An unusable entry and a repeat both start
   * unticked with a disabled box, so a group control that ticked them anyway would contradict the rows
   * directly below it.
   */
  const setKindSelected = useCallback(
    (kind: ImportCandidate["kind"], next: boolean) => {
      setDeselectedEntryIds((current) => {
        const updated = new Set(current);
        for (const candidate of importPreview?.candidates ?? []) {
          if (candidate.kind !== kind || !candidate.usable || candidate.duplicate) continue;
          if (next) updated.delete(candidate.id);
          else updated.add(candidate.id);
        }
        return updated;
      });
    },
    [importPreview],
  );

  const toggleImportKind = useCallback((kind: ImportCandidate["kind"]) => {
    setCollapsedImportKinds((current) => {
      const updated = new Set(current);
      if (updated.has(kind)) updated.delete(kind);
      else updated.add(kind);
      return updated;
    });
  }, []);

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
    // **Not while the import dialog is open.** This effect exists to point the page's editors at the
    // stored document, and the dialog's buffer is a different thing: a pending import is text the user
    // just fetched, and resetting it here replaced it with the document already open — so the preview
    // listed the OLD configuration and pressing the button imported a file nobody chose. The dialog
    // seeds its own buffer when it opens, so skipping this cannot leave it empty.
    if (importOpenRef.current) return;
    loadImportText(rawConfig, configBaseUrl ?? null);
  }, [activeConfigId, configBaseUrl, rawConfig, loadImportText]);

  /**
   * Removes entries Moseek can never run from a document that was stored before that rule existed.
   *
   * **Pruning on write is not enough.** An import, an autosave and the multi-document collapse all
   * pass through it, but a database written by an older version — or simply not edited since — keeps
   * its blocked entries in the raw text forever. Measured in a real browser with such a document:
   * the source list was clean and every removed family name was gone from the interface, while the
   * raw configuration still held four entries reading 无法测试. The user asked for these to be gone
   * from the configuration, not merely from one view of it.
   *
   * It runs once per document id and only writes when something was actually removed, so an
   * already-clean document costs one parse and no write. The guard is a ref holding the id that has
   * been handled rather than a boolean, because switching to another document must run it again.
   */
  const prunedDocumentId = useRef<number | null>(null);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (activeConfigId === null || !rawConfig.trim()) return;
    if (prunedDocumentId.current === activeConfigId) return;
    prunedDocumentId.current = activeConfigId;

    const pruned = pruneUnsupportedConfigText(rawConfig, configBaseUrl ?? null);
    if (pruned.removed === 0) return;

    const parsed = parseConfigText(
      pruned.text,
      configBaseUrl ?? activeDocument?.sourceBaseUrl ?? undefined,
    );
    const kept = sources.filter(
      (source) => !isPermanentlyUnsupportedSource(source),
    );
    void replaceAllConfigDocuments({
      name: activeDocument?.name ?? "中心配置",
      rawConfig: pruned.text,
      normalizedConfig: parsed.ok
        ? parsed.normalizedConfig
        : (activeDocument?.normalizedConfig ?? normalizedConfig),
      sources: kept,
      liveCount: parsed.ok ? parsed.liveCount : sources.filter(
        (source) => source.sourceType === "live",
      ).length,
      sourceBaseUrl: configBaseUrl ?? activeDocument?.sourceBaseUrl ?? null,
    })
      .then((saved) => {
        if (!saved) return;
        setConfigDocument(saved, true);
        setParseState({
          type: "success",
          title: "已清理无法适配的源",
          message: `配置里有 ${pruned.removed} 个源需要远程脚本或 JAR，Moseek 不会执行它们，已从配置中移除。`,
        });
      })
      .catch(() => {
        // Not fatal and not worth a message of its own: the document is still readable, the
        // interface does not render these entries, and the next edit writes a pruned document.
        prunedDocumentId.current = null;
      });
  }, [
    activeConfigId,
    rawConfig,
    configBaseUrl,
    sources,
    activeDocument,
    normalizedConfig,
    setConfigDocument,
  ]);

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
      // Unsupported entries are dropped here too. This path writes the document directly rather than
      // going through the import or autosave routes, so without this an old database would keep
      // carrying families Moseek has decided against — the list would show nothing for them and the
      // file would keep them forever.
      const prunedMerge = pruneUnsupportedConfigText(
        mergedText,
        sourceBaseUrl ?? null,
      );
      const parsed = parseConfigText(
        prunedMerge.text,
        sourceBaseUrl ?? undefined,
      );
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
      // The snapshots are pruned too, and with the same predicate the text was pruned by. Leaving
      // them would keep the removed families in the list, which is the half of this document the
      // page actually renders.
      mergedSources = mergedSources.filter(
        (source) => !isPermanentlyUnsupportedSource(source),
      );

      const saved = await replaceAllConfigDocuments({
        name: "中心配置",
        rawConfig: prunedMerge.text,
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
        message: [
          `原来的 ${ordered.length} 套配置已合并为「中心配置」：新增 ${mergedCount.added} 个源，去重 ${mergedCount.unchanged} 个，当前共 ${saved.sources.length} 个源。以后导入会继续合并进这一套。`,
          prunedMerge.removed > 0
            ? `已丢弃 ${prunedMerge.removed} 个无法适配的源（它们需要远程脚本或 JAR，Moseek 不会执行）。`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
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
    loadImportText("", null);
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
  /**
   * Which step of the 清空所有配置 confirmation is open, if any.
   *
   * **Two steps, not one, and that is the user's requirement.** Clearing the configuration deletes the
   * file they imported, and re-importing it is the only way back — so the first dialog states what will
   * be lost and the second asks again. A single confirm is the shape people click through; the second
   * step is what makes the intent deliberate rather than reflexive.
   *
   * `null` means neither is open.
   */
  const [clearStep, setClearStep] = useState<"confirm" | "final" | null>(null);
  /** Whether the clear is running, so its button reports that instead of looking inert. */
  const [isClearing, setIsClearing] = useState(false);

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

  /**
   * Removes every configuration, in one transaction, and resets the page to its empty state.
   *
   * **Why the local state is reset rather than reloaded.** The Rust side deletes the rows and the
   * activation pointer; what the page holds is a mirror of them, and re-reading would mean a round trip
   * that can fail after the deletion already happened — leaving the list showing sources that no longer
   * exist. Resetting is therefore the accurate description of what the database now contains, not an
   * optimistic guess. `clearConfigDocument` is the same store action the app uses on startup when no
   * document is found, so the empty state is one that is already known to render.
   *
   * **What deliberately survives:** favourites, footprints and playback progress. The user asked to
   * clear the configuration, not to lose what they had collected, and a favourite pointing at a source
   * that is gone reports itself as unresolvable rather than vanishing.
   *
   * The editor draft is dropped too. Leaving text in the import box that the page no longer reflects
   * would make the next 合并 look like it was importing on top of something.
   */
  const performClearAll = useCallback(async () => {
    setIsClearing(true);
    try {
      await clearAllConfigDocuments();
      clearConfigDocument();
      // **`clearConfigDocument` does not empty the document list, and the database now has none.**
      // Leaving the mirror populated made the header keep claiming a document and left 清空所有配置
      // enabled with nothing to clear — measured in a real browser: after the clear the list read
      // 0 个源 while `configDocuments` still held one entry. The store action is scoped to the active
      // document, so the list is emptied explicitly here.
      setConfigDocuments([]);
      // The merge summary describes a document that no longer exists.
      setLastMergeSummary(null);
      loadImportText("", null);
      setRawDraft(null);
      setInspectedSourceKey(null);
      setMultiRepo(null);
      setClearStep(null);
      setParseState({
        type: "success",
        title: "配置已清空",
        message:
          "所有配置文档与源都已删除，可以导入新的配置了。收藏、足迹与观看进度保留。",
      });
      toast({
        variant: "success",
        title: "配置已清空",
        description: "收藏、足迹与观看进度未受影响。",
      });
    } catch (error) {
      setClearStep(null);
      setParseState({
        type: "error",
        title: "清空失败",
        message: errorMessage(error, "无法清空配置"),
      });
      toast({
        variant: "error",
        title: "清空失败",
        description: errorMessage(error, "无法清空配置"),
      });
    } finally {
      setIsClearing(false);
    }
  }, [clearConfigDocument, setConfigDocuments, toast]);
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
  const testingOwners = useRef(new Map<string, string>());

  const handleTestSource = useCallback(
    async (source: SourceRecord) => {
      if (testingOwners.current.has(source.key)) return;
    cancelledTestKeys.current.delete(source.key);
    const runId = `single-${source.key}-${crypto.randomUUID()}`;
    singleTestRunIds.current.set(source.key, runId);
    testingOwners.current.set(source.key, runId);
    setTestingKeys((current) => new Set(current).add(source.key));
    try {
      const result = await testSource(source, runId);
      if (singleTestRunIds.current.get(source.key) !== runId || useAppStore.getState().activeConfigId !== activeConfigId) return null;
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
        if (useAppStore.getState().activeConfigId !== activeConfigId || singleTestRunIds.current.get(source.key) !== runId) return null;
      }
      // Replies contain a full snapshot, and concurrent replies can arrive out of order.
      // Apply only this result so an older reply cannot erase another source's newer result.
      setSourceTestResult(source.key, result);
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
      if (singleTestRunIds.current.get(source.key) !== runId || useAppStore.getState().activeConfigId !== activeConfigId) return null;
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
      if (singleTestRunIds.current.get(source.key) === runId) {
        singleTestRunIds.current.delete(source.key);
        if (testingOwners.current.get(source.key) === runId) testingOwners.current.delete(source.key);
        setTestingKeys((current) => {
          const next = new Set(current);
          next.delete(source.key);
          return next;
        });
      }
      void forgetSourceTestRun(runId).catch(() => undefined);
    }
    },
    [
      activeConfigId,
      setSourceTestResult,
      testSource,
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
      if (testingOwners.current.get(sourceKey) === runId) testingOwners.current.delete(sourceKey);
      void cancelSourceTest(runId)
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
  const runBatchTest = async (source: SourceRecord, runId: string, run: { cancelled: boolean }) => {
    if (run.cancelled || useAppStore.getState().activeConfigId !== activeConfigId || testingOwners.current.has(source.key)) return null;
    testingOwners.current.set(source.key, runId);
    setTestingKeys((current) => new Set(current).add(source.key));
    try {
      const result = await testSource(source, runId);
      if (run.cancelled || useAppStore.getState().activeConfigId !== activeConfigId) return null;
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
      if (run.cancelled || useAppStore.getState().activeConfigId !== activeConfigId) return null;
      void persistedDocument;
      setSourceTestResult(source.key, result);
      return result;
    } catch (error) {
      // A cancelled request rejects rather than resolving with a sentinel, so the cancellation has
      // to be recognised here too, or it would be reported as a per-source failure.
      if (isCancelledTestError(error)) return null;
      return null;
    } finally {
      if (testingOwners.current.get(source.key) === runId) {
        testingOwners.current.delete(source.key);
        setTestingKeys((current) => {
          const next = new Set(current);
          next.delete(source.key);
          return next;
        });
      }
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
    /**
     * This run's identity, which is what makes cancelling reach the sockets.
     *
     * The previous implementation only stopped the frontend from waiting: the requests stayed open
     * in Rust until their own 25 s bound and each still persisted its result, so the list kept
     * changing after "测速已取消" had been reported. A per-run id is what lets `cancelSourceTest`
     * drop exactly this batch's requests without touching a later run.
     */
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const run = { cancelled: false };
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
      run.cancelled = true;
      for (const [key, owner] of testingOwners.current) {
        if (owner === runId) testingOwners.current.delete(key);
      }
      setTestingKeys(new Set(testingOwners.current.keys()));
      releaseCancellation();
      // Fire-and-forget: the local state is already correct, and making the button await a
      // round-trip would reintroduce the delay this exists to remove.
      void cancelSourceTest(runId).catch(() => undefined);
    };
    cancelRunRef.current = cancelRequested;

    const queue = [...targets];
    const results: SourceTestResult[] = [];
    const inFlight: Promise<SourceTestResult | null>[] = [];
    // A small worker pool rather than one request at a time or all at once: testing serially made
    // a 70-source configuration take as long as the sum of every source's latency, while firing
    // every request together would open dozens of sockets and trip rate limits.
    const workers = Array.from(
      { length: Math.min(TEST_CONCURRENCY, queue.length) },
      async () => {
        for (;;) {
          if (run.cancelled) return;
          const source = queue.shift();
          if (!source) return;
          const task = runBatchTest(source, runId, run);
          inFlight.push(task);
          const outcome = await Promise.race([
            task.then((result) => ({ result })),
            cancelledSignal.then(() => null),
          ]);
          if (run.cancelled) return;
          if (outcome?.result) results.push(outcome.result);
        }
      },
    );
    await Promise.all(workers);
    const cancelled = run.cancelled;
    cancelRunRef.current = null;
    setIsBatchTesting(false);
    // The run is over, so its flag is released. Without this a long session of many batches would
    // accumulate one entry per run for the process's lifetime.
    void Promise.allSettled(inFlight).then(() => forgetSourceTestRun(runId)).catch(() => undefined);

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
    // A local file has no remote base, so its relative paths are left as written — which is what the
    // dialog's own copy tells the user.
    loadImportText(await file.text(), null);
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

  const handleFileDrop = async (event: DragEvent<HTMLElement>) => {
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

      // The base URL is passed here rather than read from state: `setConfigBaseUrl` above has not been
      // committed yet, and the preview needs the address that resolves this file's relative paths.
      loadImportText(text, sourceInput.trim());
      // **No "已载入" banner.** The list below is the confirmation: it names every resource that
      // arrived, which is more than a sentence saying something arrived. The message is reserved for
      // what the list cannot show — a note about what the address actually served, and what was
      // repaired. Setting it unconditionally said "解析完成" under a list that had already said it.
      const notes = [source.note, repairNote].filter(Boolean);
      setParseState(
        notes.length > 0
          ? { type: "success", message: notes.join("；") }
          : { type: "idle", message: "" },
      );
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
      loadImportText(source.text, new URL(url).toString());
      // Same as the single-address path: the list is the confirmation, so only an unusual note is said.
      setParseState(
        source.note ? { type: "success", message: source.note } : { type: "idle", message: "" },
      );
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

  /**
   * Applies one field edit made in the source drawer.
   *
   * **Goes through `handleRawTextChange` on purpose.** That is the single ingress the debounced save
   * watches, so an edit from the drawer lands exactly the way an edit from the editor did: pruned,
   * parsed, merged with the existing records — which is what preserves the user's own switches — and
   * written by `replaceAllConfigDocuments`. Writing to the database directly from here would bypass
   * `saveEditorText`'s re-entrancy guard and reintroduce the write loop it was added to stop.
   *
   * The entry is located from the *current* text rather than an index captured when the drawer opened,
   * because anything could have edited the document since. `locateVisualEntry` answers null when it
   * cannot be certain, and then this refuses rather than writing the wrong row.
   *
   * Returns whether the edit was applied, so the field can put the stored value back when it was not.
   */
  const handleEditSourceField = (field: string, value: string): boolean => {
    if (!inspectedEntry || !inspectedSource) return false;
    const { text, error } = updateVisualEntryField(
      editorText,
      inspectedEntry.section,
      inspectedEntry.entry.index,
      field,
      value,
    );
    if (error) {
      toast({ variant: "error", title: "没有修改", description: error });
      return false;
    }
    if (text === editorText) return false;
    handleRawTextChange(text);
    return true;
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
   * **Every save is a background save now.** The old `options.silent` distinguished the debounced
   * write from a caller that wanted a "已保存" confirmation, and that confirmation was the status line
   * under the 原始配置 editor. With the editor gone there is no such caller, so a successful write
   * says nothing and only a warning or a failure is reported.
   */
  const saveEditorText = async (text: string) => {
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
    //
    // **Pruning happens here rather than at the editor.** This is the one place every write passes
    // through, so an unsupported entry cannot survive by arriving down a path that skipped a cleanup
    // step. The text is rewritten only when something was actually removed, and the removal is what
    // makes the unsupported entries leave the *file* rather than merely the list.
    //
    // This cannot loop. The pruned text is written and stored as the document, so the next save sees
    // the same text and `pruneUnsupportedConfigText` returns it unchanged with `removed: 0`; and
    // `lastSavedText` records the text that was asked for, so the debounce does not re-fire on a
    // rewrite. Both guards were needed for other reasons already (see below), and they cover this.
    const pruned = trimmed
      ? pruneUnsupportedConfigText(text, configBaseUrl)
      : { text, removed: 0 };
    const storedText = pruned.text;
    const parsed = storedText.trim()
      ? parseConfigText(storedText, configBaseUrl)
      : null;
    const payload = resolveSavePayload({
      text: storedText,
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
      // The save replaces the document id. Mark its snapshot before the reset effect runs,
      // so a newer edit typed during the write is not replaced by the older saved text.
      draftSourceRef.current = { documentId: document.id, rawConfig: document.rawConfig };
      setConfigDocument(document, true);
      // The draft is dropped so the editors read the saved document again; keeping it would leave
      // the page showing text that no longer matches what is stored.
      setRawDraft((current) => latestEditorText.current === text ? null : current);
      // **A toast, not a status line.** The line it used to write lived under the 原始配置 editor,
      // and that editor is gone. A successful background save stays silent — it is the ordinary
      // outcome and the list already shows the result — but a warning is something the user has to
      // act on, so it is said out loud.
      if (payload.warning) {
        toast({ variant: "error", title: "配置已保存，但有需要留意的地方", description: payload.warning });
      }
    } catch (error) {
      // The text did NOT land, so a retry must still be possible. Leaving the marker set would make
      // the guard skip every later attempt at the same text, turning one transient database error
      // into permanently unsaveable edits.
      lastSavedText.current = null;
      // A failed save is never silent, whatever the caller asked for: the user's edit is not stored.
      toast({
        variant: "error",
        title: "保存失败",
        description: error instanceof Error ? error.message : "未知错误",
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
      void saveEditorText(rawDraft ?? "");
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
    // The text to merge. Normally the editor's, but the 多仓 bulk path has already merged several
    // documents in memory and hands the result over here rather than routing it through the editor.
    const incomingText = options.rawOverride ?? importText;

    // **The `moseek` key is dropped before anything else reads the text.** Exported files used to
    // carry the user's favourites and theme under that key. Two reasons it must not survive:
    //
    //  - The visual editor renders unrecognised top-level keys as rows under 其他设置, so the app's own
    //    data appeared as a TVBox client setting. 配置中心 holds resources; app data belongs in 设置.
    //  - It would then be written into the stored document and re-exported, so a file that picked it
    //    up once would keep carrying it.
    //
    // Read first, discard second: `applyImportedExtras` below restores the favourites from an older
    // export, so removing the key here loses the data only from the configuration, not from the user.
    const strippedText = stripExportExtras(incomingText);

    // **Unsupported entries are dropped before anything else looks at them.** The user's decision:
    // an adapter Moseek cannot support should not be carried around at all, because recognising it
    // tells the reader nothing and this application will never implement it. Pruning the incoming
    // side means the entries never reach the merge, the list, the export or the file.
    //
    // The count is taken from the same call that removes them, so the sentence the user reads is
    // about what actually happened rather than a second count that could disagree.
    const prunedIncoming = pruneUnsupportedConfigText(
      strippedText,
      configBaseUrl ?? null,
    );
    const prunedCount = prunedIncoming.removed;
    const incomingRawText = prunedIncoming.text;

    let mergedRawText = incomingRawText;
    let mergeReport: MergeReport | null = null;
    if (sources.length > 0 && rawConfig.trim()) {
      // Merging runs on the raw text, not on the parsed sources: the parsed model does not carry
      // every field a TVBox configuration can hold, and regenerating the file from it would discard
      // them silently.
      const existingRaw = parseRawObject(rawConfig);
      const incomingRaw = parseRawObject(
        JSON.stringify(
          absolutizeRelativeSites(
            parseRawObject(incomingRawText) ?? {},
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
    // Appended to whichever message this import reports, so the removal is never silent: the user
    // asked for it, and a file that quietly comes back smaller is exactly the kind of change that
    // has to be stated.
    const prunedNote =
      prunedCount > 0
        ? `已丢弃 ${prunedCount} 个无法适配的源（它们需要远程脚本或 JAR，Moseek 不会执行）。`
        : null;

    // The merged text is pruned as well, and for a second reason: the document already stored may
    // still carry entries from before this rule existed. Pruning only the incoming side would clean
    // what the user just handed us and leave the old ones in place forever.
    const storedRawText = pruneUnsupportedConfigText(
      mergedRawText,
      configBaseUrl ?? null,
    ).text;

    // **The snapshot is filtered, unconditionally.** `result.sources` is the caller's parse of the
    // *unpruned* text, so simply dropping entries from the raw text would leave the two halves of the
    // document describing different sets — the list would still render rows for sources the file no
    // longer contains, which is the contradiction this project has fixed repeatedly. Filtering after
    // the merge also covers entries the existing document contributed.
    const keptSources = finalSources.filter(
      (source) => !isPermanentlyUnsupportedSource(source),
    );

    // `replaceAll` rather than `save`: there is exactly one configuration, so the write is "the
    // centre configuration is now this", not "add another one". Using an insert here would quietly
    // reintroduce the pile of documents this feature exists to remove.
    const savedDocument = await replaceAllConfigDocuments({
      name,
      rawConfig: storedRawText,
      normalizedConfig: mergedParse.ok
        ? mergedParse.normalizedConfig
        : result.normalizedConfig,
      sources: keptSources,
      liveCount: mergedParse.ok ? mergedParse.liveCount : result.liveCount,
      sourceBaseUrl: configBaseUrl ?? activeDocument?.sourceBaseUrl ?? null,
    });
    const document: StoredConfigDocument = savedDocument ?? {
      id: activeConfigId ?? -Date.now(),
      name,
      rawConfig: storedRawText,
      normalizedConfig: mergedParse.ok
        ? mergedParse.normalizedConfig
        : result.normalizedConfig,
      sources: keptSources,
      sourceCount: keptSources.length,
      liveCount: mergedParse.ok ? mergedParse.liveCount : result.liveCount,
      importedAt: new Date().toISOString(),
      sourceBaseUrl: configBaseUrl ?? activeDocument?.sourceBaseUrl ?? null,
    };
    setConfigDocument(document, true);
    setLastMergeSummary(
      mergeReport
        ? {
            added: mergeReport.sites.added,
            updated: mergeReport.sites.updated,
            unchanged: sourceMerge.unchanged,
            keptLocalState: keptSources.filter((source) => !source.enabled).length,
            total: keptSources.length,
          }
        : null,
    );
    setParseState({
      type: "success",
      // A caller-supplied note wins: the 多仓 bulk path knows how many documents it merged and which
      // addresses failed, and that is more useful than the generic merge sentence. The pruned note is
      // appended to whichever sentence wins, because "some of your file was deleted" is not something
      // a summary may leave out.
      message: [
        options.successNote ??
          (mergeReport
            ? `已合并进「${name}」：新增 ${sourceMerge.added} 个源，更新 ${sourceMerge.updated} 个，${sourceMerge.unchanged} 个原本就有；当前共 ${keptSources.length} 个源。`
            : `解析完成：${keptSources.length} 个源，${result.liveCount} 个直播源；可用 ${countParsedCapabilities(keptSources).supported} 个，${result.issues.length} 个需要关注。`),
        prunedNote,
      ]
        .filter(Boolean)
        .join(" "),
    });
    setImportOpen(false);
    // Favourites and the theme, if this file carries them. Two details matter here:
    //
    //  - **`incomingText`, not `storedRawText`.** The stored text has had the `moseek` key stripped, so
    //    reading the extras from it would find nothing — the key is exactly what was removed. The
    //    original text is the only place the data still is.
    //  - Read after the configuration has been committed, so a malformed extras block cannot stop the
    //    import itself from happening — the sources are the reason the user pasted the file.
    applyImportedExtras(incomingText);
  };

  /**
   * Folds the non-configuration part of an imported file into the store.
   *
   * **Kept for files exported before 软件数据 moved to 设置.** Those carry favourites and the theme
   * under a `moseek` key. The key is stripped from the document itself — see `commitParsedConfig` — so
   * this is the only path that still reads it, and it exists so a user who exported earlier does not
   * lose the only copy they have.
   *
   * Only the fields the file actually carries are touched: a configuration written by someone else has
   * no `moseek` key at all, and one that mentions favourites but not a theme must not reset the theme
   * to a default nobody chose.
   */
  const applyImportedExtras = (text: string) => {
    const extras = readExportExtras(text);
    if (!extras) return;
    if (extras.theme) setTheme(extras.theme);
    const added = restoreFavorites({
      favorites: extras.favorites,
      liveFavorites: extras.liveFavorites,
    });
    if (added.vod > 0 || added.live > 0) {
      const parts = [
        added.vod > 0 ? `影视收藏 ${added.vod} 项` : null,
        added.live > 0 ? `直播收藏 ${added.live} 项` : null,
      ].filter(Boolean);
      toast({
        variant: "success",
        title: "已恢复收藏",
        description: `从这份配置里恢复了${parts.join("、")}；已有的收藏保持不变。`,
      });
    }
  };

  /**
   * Commits the import the user confirmed.
   *
   * **The text is filtered by the selection before anything else looks at it**, so every downstream
   * step — the merge, the prune, the write, the `parses` it carries — works on the entries the user
   * chose. Filtering after the merge would be too late: by then the unticked entries are already in the
   * centre configuration and there is nothing left to distinguish them.
   *
   * The parse still runs, and failing it is still reported. It should not fail — the preview parsed the
   * same text — but a message is better than a silent no-op if the two ever disagree.
   */
  const handleParse = async () => {
    setIsParsing(true);
    const selectedText = importPreview
      ? keepSelectedEntries(importPreview.text, importPreview.candidates, selectedEntryIds)
      : importText;
    const result = parseConfigText(selectedText, configBaseUrl);

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
      await commitParsedConfig(result, { rawOverride: selectedText });
    } catch (error) {
      saveParseError(error);
    } finally {
      setIsParsing(false);
    }
  };

  /**
   * Writes the configuration the user is looking at.
   *
   * **Two things changed here, both because the file and the screen disagreed.**
   *
   * 1. **The text is rebuilt from `sources`, not read from `normalizedConfig`.** Those are maintained
   *    separately, and when they drift the export silently describes a different set of sources from
   *    the list. Reported as "导出前 60 个，重新导入后 55 个" — the file held 55 while the page showed
   *    60, and the import was faithful to the file. Deriving the collections at write time makes the
   *    two agree by construction.
   *
   * 2. **No `moseek` key.** Favourites and the theme used to ride along under a namespaced key, which
   *    made a configuration file carry the user's own app data. The visual editor renders unrecognised
   *    top-level keys as rows under 其他设置, so importing that file showed 收藏 as a "TVBox 客户端的
   *    设置" — confusing, and the user's own conclusion is the design rule: 配置中心 holds resources,
   *    and app data belongs in 设置.
   *
   * The extras still have to be *read* on import, because a file exported by an older version of this
   * app carries them. They are read and then discarded — see `applyImportedExtras`.
   */
  const handleExport = async () => {
    // The write happens in Rust, behind a real save dialog. The previous version built a blob URL and
    // clicked a detached anchor, which did nothing at all in this webview while reporting no error —
    // see `export_config_file` for the mechanism. Every outcome is now stated, including the one
    // where the user changes their mind.
    try {
      const text = buildExportConfigText(normalizedConfig, sources);
      const saved = await exportConfigFile(text, activeConfigId ?? undefined);
      if (!saved) {
        // A dismissed dialog is an ordinary outcome, not a failure, so nothing is reported.
        return;
      }
      setParseState({
        type: "success",
        message:
          `已导出到 ${saved.path}（${Math.round(saved.bytes / 1024)} KB）` +
          `，含 ${sources.filter((source) => source.sourceType !== "live").length} 个影视源、` +
          `${sources.filter((source) => source.sourceType === "live").length} 个直播源。`,
      });
    } catch (error) {
      setParseState({
        type: "error",
        message: errorMessage(error, "本地配置导出失败"),
      });
    }
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
          {/* The one destructive action on this page, and the only place it is offered.
              Disabled when there is nothing to clear, so it cannot be pressed to no effect — the same
              rule the storage tab's clear buttons follow. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={sources.length === 0 && !rawConfig.trim() && configDocuments.length === 0}
            onClick={() => setClearStep("confirm")}
          >
            <Trash2 className="size-3.5" data-icon="inline-start" aria-hidden="true" />
            清空所有配置
          </Button>
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

        {/* **No tab row.** The page had three tabs — 源列表, 适配器 and 原始配置 — and the user
            removed two of them: 适配器 because they could not read an adapter table, and 原始配置
            because an editor over the raw file is not something a user of this app should have to
            open. What is left is the list, and a control with one destination is not a control:
            this project's own `do-not-use.md` rejects exactly that.

            The wrapper stays an unconditioned `div` rather than a bare fragment because it is what
            gives the card the page's remaining height. */}
        <div className="flex min-h-0 flex-1 flex-col gap-5">
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
                    <SearchInput
                      value={query}
                      onValueChange={setQuery}
                      placeholder="搜索源名称或 API"
                      aria-label="搜索源名称或 API"
                    />
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
                        {/* **"Nothing to show" and "nothing matches" are different problems, and the
                            order of these checks decides which one the user is told about.**
                            The page opens with a filter already applied — `defaultSourceFilter` keeps
                            `executions: ["enabled"]` so the list is not a wall of sources with no
                            adapter — which means `isFilterUnfiltered` is false from the first render.
                            Testing the filter first therefore made the "当前配置没有源" branch
                            unreachable, and a configuration with no sources at all was reported as
                            "调整关键词或筛选条件后重试": advice to adjust a filter that can never
                            produce a row. Measured after 清空所有配置, where the list is genuinely
                            empty and the message blamed the user's filtering.
                            An empty configuration is the more specific fact, so it is tested first. */}
                        <EmptyTitle>
                          {sources.length === 0
                            ? "当前配置没有源"
                            : isFilterUnfiltered(sourceFilter) && !query.trim()
                              ? "列表里没有源"
                              : "没有匹配的源"}
                        </EmptyTitle>
                        <EmptyDescription>
                          {sources.length === 0
                            ? "导入一份配置后，源会出现在这里。"
                            : isFilterUnfiltered(sourceFilter) && !query.trim()
                              ? "这份配置里确实没有可用的源。"
                              : "调整关键词或筛选条件后重试。"}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

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
              从一条链接或一个文件导入资源。读到的内容会列在下面，可以只导入其中几个；需要远程脚本或
              JAR 的条目 Moseek 不会执行，也不会带进来。
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
            {/* No 配置名称 field: an import merges into 中心配置, so the name the user typed was
                discarded immediately — the document keeps the centre configuration's own name. Asking
                for a value that cannot be used is worse than not asking: it implies the import
                creates something separate, which is exactly the model this page removed. */}

            {/* **The page's own tab component, not a pair of Buttons.** Two buttons styled to look like
                tabs were a second, slightly different implementation of something the app already has:
                the same view was drawn with `bg-muted/50` plus `variant="secondary"` instead of the
                shared `TabsList`/`TabsTrigger`, so its metrics and its focus ring did not match the
                tabs a user sees two clicks away in 原始配置. */}
            <Tabs
              value={importMode}
              onValueChange={(value) => {
                setImportMode(value as "remote" | "local");
                setIsDraggingFile(false);
                setParseState({ type: "idle", message: "" });
              }}
              className="shrink-0"
            >
              <TabsList>
                <TabsTrigger value="remote" className="gap-1.5">
                  <Globe2 className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                  远程 URL
                </TabsTrigger>
                <TabsTrigger value="local" className="gap-1.5">
                  <FileUp className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                  本地文件
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {importMode === "remote" ? (
              <div className="flex shrink-0 flex-col gap-2">
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
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={handleFetchRemote}
                    disabled={isFetchingRemote || !sourceInput.trim()}
                  >
                    <Globe2 className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                    {isFetchingRemote ? "请求中…" : "获取配置"}
                  </Button>
                </div>
                {/* Stated here rather than as a line under both tabs: it is true of a remote
                    configuration and meaningless for a local file. */}
                <p className="text-xs text-muted-foreground">
                  配置里的 ./ 相对地址会按这个 URL 的目录解析。
                </p>
              </div>
            ) : (
              /* A drop zone that is one control, not a panel with a button in it.
                 The previous version put a bordered `Button` inside a bordered dashed box — two nested
                 boxes for one action, and the inner button's own border sat a few pixels from the
                 outer one. The whole area is now the target: it is a button, it accepts a drop, and it
                 names the file once there is one. */
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                  setIsDraggingFile(true);
                }}
                onDragLeave={() => setIsDraggingFile(false)}
                onDrop={handleFileDrop}
                className={cn(
                  "flex h-16 shrink-0 items-center gap-3 rounded-lg border border-dashed border-border/80 bg-card/40 px-4 text-left transition-colors",
                  "hover:border-primary/50 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  isDraggingFile && "border-primary bg-accent/40",
                )}
              >
                <FileUp
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">
                    {selectedFileName || "选择配置文件"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {selectedFileName
                      ? "已读取，下面列出它包含的资源"
                      : "点击选择，或把 JSON / JSON5 文件拖到这里"}
                  </span>
                </span>
              </button>
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
                        {/* Same scale as every other list in this dialog: 14px/500 for the name,
                            12px mono for the address. See `ImportEntryText` for why. */}
                        <span className="text-sm font-medium text-foreground">{entry.name}</span>
                        <span className="break-all font-mono text-xs text-muted-foreground">
                          {entry.url}
                        </span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
            {/* The two explanatory lines that sat here are gone. "远程请求由 Rust 请求层执行" describes
                an implementation detail the user cannot act on, and "支持拖入或选择本地 JSON / JSON5
                文件" restated what the drop zone's own second line already says. The one fact worth
                keeping — that a remote configuration's `./` paths resolve against its URL — is stated
                where it matters, beside the address field, and only on the tab it applies to. */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.json5,application/json"
              className="hidden"
              onChange={handleFilePick}
            />
            {/* **The list, not the text.** What an import offers is a choice about what to bring in,
                and the only surface where that choice can be made is one that shows what is in the
                file. An editor showed the bytes, which the intended user cannot evaluate, and then
                asked them to press 合并进中心配置 — a decision about a document they had no way to
                judge. Every source is listed with its name and address, ticked by default, and the
                grouping is the one the source list itself uses. */}
            {importPreview ? (
              importPreview.ok ? (
                <ImportCandidateList
                  preview={importPreview}
                  deselectedIds={deselectedEntryIds}
                  collapsedKinds={collapsedImportKinds}
                  onToggle={toggleEntry}
                  onSetKind={setKindSelected}
                  onToggleKind={toggleImportKind}
                />
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed bg-muted/20 p-6">
                  <div className="max-w-md text-center">
                    <AlertTriangle
                      className="mx-auto size-5 text-destructive"
                      aria-hidden="true"
                    />
                    <p className="mt-3 text-sm font-medium text-foreground">
                      这份配置读不出来
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {importPreview.error}
                      {importPreview.errorPath
                        ? `（字段 ${importPreview.errorPath}）`
                        : ""}
                    </p>
                  </div>
                </div>
              )
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                填入一个地址或选择一个文件，这里会列出它包含的资源。
              </div>
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
            {/* The count is stated here, where the commit happens, rather than only in the list's
                header: the button and the number it acts on belong together, and "导入 12 个" is a
                clearer promise than "合并进中心配置". */}
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
              disabled={
                isParsing ||
                !importPreview?.ok ||
                selectedEntryIds.size === 0
              }
            >
              <FileJson className="size-4" data-icon="inline-start" aria-hidden="true" />
              {isParsing
                ? "导入中…"
                : selectedEntryIds.size === 0
                  ? "请至少选择一个"
                  : `导入 ${selectedEntryIds.size} 个资源`}
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

      {/* 清空所有配置 — step one of two.
          It names what is lost *and* what is kept, because the fear this dialog has to answer is
          "will this take my favourites with it", and the honest answer is no. */}
      <Dialog
        open={clearStep === "confirm"}
        onOpenChange={(open) => {
          if (!open && !isClearing) setClearStep(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>清空所有配置？</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  将删除当前的全部配置：
                  <span className="font-semibold text-foreground">
                    {configDocuments.length}
                  </span>{" "}
                  份配置文档、
                  <span className="font-semibold text-foreground">{sources.length}</span>{" "}
                  个源，以及原始配置与归一化配置。
                </p>
                <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  <li>删除后列表和原始配置都会变空，回到首次启动的样子。</li>
                  <li>
                    <span className="text-foreground">收藏、足迹与观看进度保留</span>
                    ，它们不属于配置。
                  </li>
                  <li>
                    收藏里指向已删除源的影视会显示为无法解析；重新导入后即可恢复。
                  </li>
                  <li>此操作不能撤销，除非你手上还有原始配置文件。</li>
                </ul>
                <p className="text-xs text-muted-foreground">
                  下一步还会再确认一次。
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isClearing}
              onClick={() => setClearStep(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="gap-1.5"
              disabled={isClearing}
              onClick={() => setClearStep("final")}
            >
              继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 清空所有配置 — step two of two.
          Deliberately plainer than the first: the reasoning was given there, and repeating it would
          make the second step feel like the same dialog rather than a distinct confirmation. */}
      <Dialog
        open={clearStep === "final"}
        onOpenChange={(open) => {
          if (!open && !isClearing) setClearStep(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>最后确认</DialogTitle>
            <DialogDescription>
              再次确认：{sources.length} 个源与全部配置文档将被永久删除。此操作不能撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isClearing}
              onClick={() => setClearStep(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="gap-1.5"
              disabled={isClearing}
              onClick={() => void performClearAll()}
            >
              {isClearing && (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              )}
              {isClearing ? "正在清空…" : "确认清空"}
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

                  {/* **Where a source is edited, now that 原始配置 is gone.** The drawer is the one
                      place a user acts on a single source, so its fields belong here rather than
                      behind a tab holding 340 sibling entries.

                      It is deliberately the *same* form the visual editor offered — same field order,
                      same 必需/可选 labels, same commit-on-blur — because the underlying operations are
                      the same functions. What is gone is the surrounding page editor: the search box,
                      the section accordions, and 其他设置, none of which mean anything when the user
                      has already said which source they are looking at.

                      When the entry cannot be located the section explains why instead of showing a
                      form. `locateVisualEntry` refuses rather than guessing, and a form that wrote to
                      the wrong row would be worse than no form. */}
                  {inspectedEntry ? (
                    <DetailSection title="编辑">
                      <div className="flex flex-col gap-2.5">
                        {inspectedEntry.entry.fields.map((field) => (
                          <SourceFieldRow
                            key={field.name}
                            field={field}
                            onCommit={(value) => handleEditSourceField(field.name, value)}
                          />
                        ))}
                      </div>
                    </DetailSection>
                  ) : (
                    <DetailSection title="编辑">
                      <p className="rounded-lg border border-border/70 bg-muted/20 p-3.5 text-xs leading-5 text-muted-foreground">
                        {describeUneditableSource(inspectedSource)}
                      </p>
                    </DetailSection>
                  )}

                  <AdapterDetail source={inspectedSource} />

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

/**
 * What an imported configuration contains, as a list the user ticks.
 *
 * **Laid out like 原始配置's section list**, which the user asked for by name: a bordered box per group
 * with a chevron heading, so the two views of the same document read the same way. Collapsing was the
 * specific request — a configuration can carry 130 解析服务, and without it the group the user came for
 * is a scroll away.
 *
 * Grouped by 影视源 / 直播源 / 解析服务 — the words 原始配置 uses and the words the file is organised
 * into, so a user who has looked at their own configuration once already knows them.
 *
 * **An entry that cannot be imported is listed but cannot be ticked**, for two distinct reasons:
 *
 *  - *Unusable* — it cannot run. Importing it would add a row that only ever reads 配置无效, and a
 *    switch that can be turned on implies it would work.
 *  - *Duplicate* — an earlier entry already carries its identity, so importing it would create nothing:
 *    the merge collapses the two and the second silently disappears. It is shown because the user is
 *    looking at a file whose count differs from their list, and "why" is the useful answer.
 *
 * Both start unticked, their boxes are disabled, and the group control skips them in both directions.
 */
function ImportCandidateList({
  preview,
  deselectedIds,
  collapsedKinds,
  onToggle,
  onSetKind,
  onToggleKind,
}: {
  preview: ImportPreview;
  deselectedIds: ReadonlySet<string>;
  collapsedKinds: ReadonlySet<ImportCandidate["kind"]>;
  onToggle: (id: string, next: boolean) => void;
  onSetKind: (kind: ImportCandidate["kind"], next: boolean) => void;
  onToggleKind: (kind: ImportCandidate["kind"]) => void;
}) {
  const kinds = ["site", "live", "parser"] as const;
  /** Whether a row can be ticked at all: runnable, and not something the merge will collapse away. */
  const isSelectable = (entry: ImportCandidate) => entry.usable && !entry.duplicate;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="text-muted-foreground">
          共 <span className="font-medium tabular-nums text-foreground">{preview.counts.total}</span>{" "}
          个资源，
          <span className="font-medium tabular-nums text-foreground">
            {preview.counts.selectable}
          </span>{" "}
          个可导入
          {preview.counts.duplicate > 0 && (
            <>
              ，
              <span className="font-medium tabular-nums text-foreground">
                {preview.counts.duplicate}
              </span>{" "}
              个重复
            </>
          )}
          {preview.counts.unusable > 0 && (
            <>
              ，
              <span className="font-medium tabular-nums text-foreground">
                {preview.counts.unusable}
              </span>{" "}
              个暂时不能用
            </>
          )}
          {preview.counts.duplicate + preview.counts.unusable > 0 && "，后两类已取消勾选"}
        </span>
        {preview.repairNote && (
          <span className="text-muted-foreground">{preview.repairNote}</span>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 pr-3">
          {kinds.map((kind) => {
            const entries = preview.candidates.filter((candidate) => candidate.kind === kind);
            if (entries.length === 0) return null;
            const selectable = entries.filter(isSelectable);
            const selectedCount = selectable.filter((entry) => !deselectedIds.has(entry.id)).length;
            const allSelected = selectable.length > 0 && selectedCount === selectable.length;
            const someSelected = selectedCount > 0;
            const isOpen = !collapsedKinds.has(kind);
            const duplicateCount = entries.filter((entry) => entry.duplicate).length;

            return (
              <section
                key={kind}
                className="rounded-lg border border-border/70 bg-card/40"
              >
                {/* The heading is a button, exactly as in 原始配置: the chevron, the name, the counts.
                    The checkbox sits outside it — a box inside a button is two controls in one hit
                    target, and clicking the row to select would conflict with clicking it to fold. */}
                {/* **The heading's own padding, with the checkbox outside it**, mirroring 原始配置.
                    There the chevron sits at the box's 8px inset; here the checkbox occupies that spot,
                    so the heading starts after it. `pl-2` on the wrapper plus `gap-2` keeps the same
                    8px rhythm between the box and the chevron, and `py-2.5` matches the entry rows
                    above and below — measured, both are 40px tall. */}
                <div className="flex items-center gap-2 py-2.5 pl-2 pr-2">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    disabled={selectable.length === 0}
                    onCheckedChange={() => onSetKind(kind, !allSelected)}
                    aria-label={`全选${IMPORT_KIND_LABELS[kind]}`}
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={isOpen}
                    onClick={() => onToggleKind(kind)}
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    {/* `text-sm font-medium`, the same as 原始配置的区块标题 and 源列表的行名 —
                        measured 14px/500 in all three places. */}
                    <span className="text-sm font-medium text-foreground">
                      {IMPORT_KIND_LABELS[kind]}
                    </span>
                    <Badge variant="secondary" className="tabular-nums">
                      {selectedCount} / {selectable.length}
                    </Badge>
                    {/* The repeats are named in the heading rather than left as a silent difference
                        between this count and the file's own. */}
                    {duplicateCount > 0 && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {duplicateCount} 个重复
                      </span>
                    )}
                    {!isOpen && (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {entries
                          .slice(0, 4)
                          .map((entry) => entry.name)
                          .join("、")}
                        {entries.length > 4 ? "…" : ""}
                      </span>
                    )}
                  </button>
                </div>

                {isOpen && (
                  <ul className="flex flex-col border-t border-border/60 py-1">
                    {entries.map((entry) => (
                      <li key={entry.id}>
                        {/* A tickable row is a label, so the whole row is the target. One that cannot
                            be ticked is not: the box is disabled, and wrapping it in a label would make
                            the row look clickable while nothing happened. */}
                        {isSelectable(entry) ? (
                          <label className="flex cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 transition-colors hover:bg-accent/40">
                            <Checkbox
                              checked={!deselectedIds.has(entry.id)}
                              onCheckedChange={(checked) => onToggle(entry.id, checked === true)}
                              className="mt-0.5"
                              aria-label={entry.name}
                            />
                            <ImportEntryText entry={entry} />
                          </label>
                        ) : (
                          <div className="flex items-start gap-2.5 px-2 py-1.5 opacity-70">
                            <Checkbox
                              checked={false}
                              disabled
                              className="mt-0.5 cursor-not-allowed"
                              aria-label={`${entry.name}（${entry.duplicate ? "重复" : "不可用"}）`}
                            />
                            <ImportEntryText entry={entry} />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * The name, address and — when it cannot be imported — the reason, shared by both row shapes.
 *
 * A repeat is reported **before** usability: an entry can be perfectly usable and still be a duplicate,
 * and "an earlier entry already carries this" is the fact that explains why the count differs from the
 * file's own. Reporting it as 不可用 would be wrong — nothing is wrong with it.
 */
function ImportEntryText({ entry }: { entry: ImportCandidate }) {
  const badge = entry.duplicate
    ? { label: "重复", className: "border-border bg-muted text-muted-foreground" }
    : entry.usable
      ? null
      : { label: "不可用", className: "border-destructive/30 bg-destructive/10 text-destructive" };
  const note = entry.duplicate
    ? "与上面某一条完全相同，导入后会被自动合并。"
    : entry.usable
      ? ""
      : entry.note;

  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            // `font-medium` and `text-sm`, the same as a row in 源列表 and an entry in 原始配置 —
            // measured: both render 14px/500. Without the weight the name read lighter here than the
            // same name one click away, which is the kind of difference that is felt before it is seen.
            "truncate text-sm font-medium",
            badge ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {entry.name}
        </span>
        {badge && (
          <Badge
            variant="outline"
            // `text-[10px]` matches the 必需 and 重复 badges in 原始配置: a small badge is 10px across
            // this page, and the shared Badge's own 12px would make these read as content.
            className={cn("shrink-0 px-1 py-0 text-[10px] font-normal leading-4", badge.className)}
          >
            {badge.label}
          </Badge>
        )}
      </span>
      {/* `text-xs` (12px), not 11px. The configuration centre renders every displayed monospace value
          — a source address, an adapter id — at `font-mono text-xs`, and 11px is reserved for the
          editable mono inputs in 原始配置. A read-only address is the former. */}
      <span className="truncate font-mono text-xs text-muted-foreground">
        {entry.address || "没有地址"}
      </span>
      {note && <span className="text-xs leading-5 text-muted-foreground">{note}</span>}
    </span>
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

/**
 * Why the drawer cannot offer an edit form for this source.
 *
 * **Saying which of the reasons it is.** "无法编辑" on its own reads as a defect; each of these is a
 * situation the user can understand, and two of them suggest what to do instead.
 */
function describeUneditableSource(source: SourceRecord) {
  if (source.sourceType === "live" && !source.api.trim()) {
    return "这一条在配置里没有地址，所以没有可以修改的字段。重新导入一份带地址的配置即可。";
  }
  if (!source.api.trim()) {
    return "这一条在配置里没有地址，所以没有可以修改的字段。";
  }
  return "Moseek 无法在配置文本里确定这一条的位置（可能有多条完全相同的地址），因此不提供编辑。删除后重新导入可以替代。";
}

/**
 * One editable field in the source drawer.
 *
 * A local draft committed on blur, the same shape the visual editor used, and for the same measured
 * reason: committing per keystroke re-serialises the whole configuration — on the owner's file that was
 * visible lag — and it fights the caret.
 *
 * `lastValue` rather than an effect for picking up an outside change: the field object is rebuilt from
 * the text on every save, so a successful commit comes back as a new `value`, and the draft has to
 * follow it or the box would keep showing the pre-save text.
 */
function SourceFieldRow({
  field,
  onCommit,
}: {
  field: VisualField;
  /** Returns whether the edit was applied; `false` puts the stored value back in the box. */
  onCommit: (value: string) => boolean;
}) {
  const [draft, setDraft] = useState(field.value);
  const [lastValue, setLastValue] = useState(field.value);
  if (lastValue !== field.value) {
    setLastValue(field.value);
    setDraft(field.value);
  }

  const commit = () => {
    if (draft === field.value) return;
    // **A refused edit puts the stored value back.** Leaving the typed text in the box would show a
    // value the file does not contain — the user would read "the address is empty now" from a field
    // whose edit was rejected, and the next unrelated save would look like it lost it. The refusal is
    // already reported by a toast; this makes the field agree with it.
    if (!onCommit(draft)) setDraft(field.value);
  };

  const label = (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="font-mono">{field.name}</span>
      {field.required && (
        <Badge
          variant="destructive"
          className="px-1 py-0 text-[10px] font-normal leading-4"
          title="必需：缺少它这个条目无法工作。"
        >
          必需
        </Badge>
      )}
    </span>
  );

  if (field.kind === "flag") {
    return (
      <label className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5">
        {label}
        <Switch
          size="sm"
          checked={draft === "true"}
          aria-label={field.name}
          onCheckedChange={(checked) => onCommit(checked ? "true" : "false")}
        />
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      {label}
      {field.kind === "json" ? (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          rows={3}
          spellCheck={false}
          aria-label={field.name}
          className={cn(
            "w-full rounded-md border border-input/80 bg-input/20 px-2.5 py-1.5 font-mono text-[11px] leading-5 shadow-2xs outline-none",
            "focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20",
          )}
        />
      ) : (
        <Input
          size="sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          aria-label={field.name}
          className={field.kind === "text" && field.name !== "name" ? "font-mono" : undefined}
        />
      )}
    </label>
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
