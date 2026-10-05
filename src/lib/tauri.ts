import { Channel, invoke } from "@tauri-apps/api/core";

import { hasScriptArchive } from "@/lib/adapters";
import type {
  CatalogPage,
  EpgCatalog,
  LiveCatalog,
  ParseServiceRecord,
  ScriptArchiveSummary,
  SourceRecord,
  SourceTestResult,
  VodItem,
} from "@/types/moseek";

export interface StoredConfigDocument {
  id: number;
  name: string;
  rawConfig: string;
  normalizedConfig: string;
  sources: SourceRecord[];
  sourceCount: number;
  liveCount: number;
  sourceBaseUrl?: string | null;
  importedAt: string;
}

export interface ConfigDocumentSummary {
  id: number;
  name: string;
  sourceCount: number;
  liveCount: number;
  importedAt: string;
}

export interface SaveConfigDocumentInput {
  name: string;
  rawConfig: string;
  normalizedConfig: string;
  sources: SourceRecord[];
  liveCount: number;
  sourceBaseUrl?: string | null;
}

export interface ConfigDuplicateMatch {
  documentId: number;
  documentName: string;
  kind: "identical" | "derived" | "same-origin";
  candidateSourceCount: number;
  documentSourceCount: number;
  sharedSourceCount: number;
}

export interface FindConfigDuplicateInput {
  rawConfig: string;
  sourceKeys: string[];
  sourceBaseUrl?: string | null;
}

export interface PlaybackResolution {
  url: string;
  mediaKind: "hls" | "mp4" | "unknown";
  adapterId: string;
  parseServiceId?: string | null;
  headers?: Record<string, string>;
}

export interface MediaResource {
  bodyBase64: string;
  contentType?: string | null;
  url: string;
}

/** The container a media address actually serves, decided from its leading bytes. */
export interface MediaContainerProbe {
  container: "flv" | "mpegts" | "hls" | "html" | "unknown";
  contentType?: string | null;
  /** The address the probe finally landed on, after redirects. */
  url: string;
  probedBytes: number;
  message: string;
}

/** Metadata for a live stream, delivered before any media bytes. */
export interface MediaStreamMeta {
  kind: "meta";
  url: string;
  contentType?: string | null;
}

/** Outcome of probing one live line. `ok` means a real manifest was served, not just a 200. */
export interface StreamProbe {
  index: number;
  url: string;
  ok: boolean;
  status?: number | null;
  contentType?: string | null;
  mediaKind: string;
  elapsedMs: number;
  message: string;
}

export interface ScriptExecutionRequest {
  script: string;
  entry?: string;
  input?: unknown;
  httpHosts?: string[];
  httpHeaders?: Record<string, string>;
  modules?: Record<string, string>;
}

export interface ScriptExecutionResult {
  value: unknown;
  adapterId: string;
  httpCallCount: number;
  diagnostics: ScriptExecutionDiagnostics;
}

export interface ScriptHttpDiagnostic {
  host: string;
  durationMs: number;
  status: string;
  errorKind?: string | null;
}

export interface ScriptExecutionDiagnostics {
  status: string;
  phase: string;
  durationMs: number;
  httpCallCount: number;
  httpHosts: string[];
  httpCalls: ScriptHttpDiagnostic[];
  errorKind?: string | null;
  timedOut: boolean;
  credentialLookupFailed: boolean;
}

export interface ScriptExecutionLog extends ScriptExecutionDiagnostics {
  id: number;
  archiveId?: number | null;
  entry: string;
  createdAt: string;
}

export interface SaveScriptArchiveInput {
  name: string;
  fileName: string;
  script: string;
  entry?: string;
  httpHosts?: string[];
  httpHeaders?: Record<string, string>;
  modules?: Record<string, string>;
}

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function listConfigDocuments() {
  return invokeCommand<ConfigDocumentSummary[]>("list_config_documents");
}

export async function loadActiveConfig() {
  return invokeCommand<StoredConfigDocument | null>("load_active_config");
}

export async function activateConfigDocument(documentId: number) {
  return invokeCommand<StoredConfigDocument>("activate_config_document", {
    documentId,
  });
}

export async function deleteConfigDocument(documentId: number) {
  return invokeCommand<StoredConfigDocument | null>("delete_config_document", {
    documentId,
  });
}

export async function saveConfigDocument(input: SaveConfigDocumentInput) {
  return invokeCommand<StoredConfigDocument>("save_config_document", { input });
}

/**
 * Replaces every stored configuration with one merged document.
 *
 * Moseek keeps a single 中心配置, so the first launch after that became true collapses whatever
 * the user already had into one row. The merging itself happens in `config-merge.ts`, beside the
 * parser; this only performs the swap.
 */
export async function replaceAllConfigDocuments(input: SaveConfigDocumentInput) {
  return invokeCommand<StoredConfigDocument>("replace_all_config_documents", {
    input,
  });
}

/**
 * Looks for an existing document that the configuration about to be imported resembles, so
 * the import can offer the user a choice instead of silently creating a near-duplicate.
 * Returns null when nothing similar is stored, and also in browser preview.
 */
export async function findConfigDuplicate(input: FindConfigDuplicateInput) {
  return invokeCommand<ConfigDuplicateMatch | null>("find_config_duplicate", {
    ...input,
  });
}

export async function setSourceEnabled(
  documentId: number,
  sourceKey: string,
  enabled: boolean,
) {
  return invokeCommand<StoredConfigDocument>("set_source_enabled", {
    documentId,
    sourceKey,
    enabled,
  });
}

/**
 * Removes sources from a saved configuration, in both the normalized snapshot and the raw text
 * the user imported, so a removed source does not come back on the next import or export.
 */
export async function removeSources(documentId: number, sourceKeys: string[]) {
  return invokeCommand<StoredConfigDocument>("remove_sources", {
    documentId,
    sourceKeys,
  });
}

export async function setSourceScriptArchive(
  documentId: number,
  sourceKey: string,
  archiveId: number | null,
) {
  return invokeCommand<StoredConfigDocument>("set_source_script_archive", {
    documentId,
    sourceKey,
    archiveId,
  });
}

export async function updateSourceTest(
  documentId: number,
  sourceKey: string,
  result: SourceTestResult,
) {
  return invokeCommand<StoredConfigDocument>("update_source_test", {
    documentId,
    sourceKey,
    result,
  });
}

export async function exportConfig(documentId?: number) {
  return invokeCommand<string>("export_config", {
    documentId: documentId ?? null,
  });
}

/** Where an exported configuration was written. */
export interface ExportedConfigFile {
  path: string;
  bytes: number;
}

/**
 * Writes the configuration to a file the user chooses.
 *
 * Resolves to `null` when the user dismisses the dialog, which is not a failure. The previous
 * approach built a blob URL and clicked a detached anchor, which silently did nothing in this
 * webview — see the Rust side for the mechanism.
 *
 * `text` is the finished document. The caller supplies it because an export also carries the parts
 * that are not configuration (favourites, theme), and those live in the webview's storage.
 */
export async function exportConfigFile(text: string, documentId?: number) {
  return invokeCommand<ExportedConfigFile | null>("export_config_file", {
    documentId: documentId ?? null,
    text,
  });
}

/**
 * What fetching a configuration address produced.
 *
 * `text` is null when the address served only a picture, and `kind` says which of the four shapes came
 * back — because several of the addresses users paste are landing pages or subscription lists rather
 * than configurations, and each needs a different thing said about it.
 */
export interface FetchedConfig {
  text: string | null;
  kind: string;
  note?: string | null;
  pageTitle?: string | null;
}

export async function fetchConfigUrl(url: string) {
  return invokeCommand<FetchedConfig>("fetch_config_url", { url });
}

/** What checking one script address found. */
export interface ScriptAddressProbe {
  url: string;
  /** `reachable`, `refused`, `missing` or `unreachable`. */
  verdict: string;
  message: string;
  /** A mirror address that serves the same file, when one works. */
  mirrorUrl: string | null;
  mirrorReason: string | null;
}

/**
 * Checks whether a source's script address can actually be fetched.
 *
 * Returns null in browser preview, where the command is not registered. The probe distinguishes a
 * host refusing from a file being gone, which is what lets the interface stop reporting both as a
 * missing sandbox.
 */
export async function probeScriptAddress(url: string) {
  return invokeCommand<ScriptAddressProbe>("probe_script_address", { url });
}

export async function setConfigSourceBaseUrl(
  documentId: number,
  sourceBaseUrl: string,
) {
  return invokeCommand<StoredConfigDocument>("set_config_source_base_url", {
    documentId,
    sourceBaseUrl,
  });
}

export async function recoverKnownLiveSources(documentId: number) {
  return invokeCommand<StoredConfigDocument | null>(
    "recover_known_live_sources",
    { documentId },
  );
}

export async function browseSource(
  source: SourceRecord,
  query: string,
  categoryId: string,
  page: number,
  pageSize: number,
) {
  return invokeCommand<CatalogPage>("browse_source", {
    source,
    query,
    categoryId,
    page,
    pageSize,
  });
}

/**
 * Tests one source.
 *
 * `runId` is what makes the test cancellable. It names the batch run this request belongs to, so
 * `cancelSourceTest` can reach exactly those requests and drop them — which is what actually closes
 * the sockets, rather than only abandoning the wait for them. Optional, because a single row's test
 * is not part of a batch and has nothing to cancel it as a group.
 */
export async function testSource(source: SourceRecord, runId?: string) {
  const command =
    source.sourceType === "live"
      ? "test_live_source"
      : hasScriptArchive(source)
        ? "test_script_source"
        : "test_source";
  return invokeCommand<SourceTestResult>(command, {
    source,
    runId: runId ?? null,
  });
}

/**
 * Asks the backend to drop every in-flight request belonging to a batch run.
 *
 * Without this, cancelling only stopped the frontend from *waiting*: the requests stayed open until
 * their own 25 s bound and each still persisted its result, so the source list kept changing after
 * the run had been reported as cancelled.
 */
export async function cancelSourceTest(runId: string) {
  return invokeCommand<void>("cancel_source_test", { runId });
}

/** Releases a finished run's cancellation flag, so flags do not accumulate per batch. */
export async function forgetSourceTestRun(runId: string) {
  return invokeCommand<void>("forget_source_test_run", { runId });
}

export async function getDetail(source: SourceRecord, vodId: string) {
  return invokeCommand<VodItem | null>("get_detail", {
    source,
    vodId,
  });
}

export async function loadLiveSource(source: SourceRecord) {
  return invokeCommand<LiveCatalog>("load_live_source", { source });
}

export async function getEpg(sourceUrl: string, format: string) {
  return invokeCommand<EpgCatalog>("get_epg", { sourceUrl, format });
}

/**
 * Resolves an episode address into something the player can load.
 *
 * `allowPageScan` opts this into scanning the address when it is a player page rather than a media
 * file, which is how ordinary CMS episodes are usually delivered. It is off for live channels: a
 * live address has no extension either, but it is a running stream rather than markup, and the live
 * workspace probes its lines properly instead.
 */
export async function resolvePlayback(
  url: string,
  parseServices: ParseServiceRecord[] = [],
  allowPageScan = false,
) {
  return invokeCommand<PlaybackResolution>("resolve_playback", {
    url,
    parseServices,
    allowPageScan,
  });
}

export async function fetchMediaResource(
  url: string,
  headers: Record<string, string> = {},
  maxBytes?: number,
) {
  return invokeCommand<MediaResource>("fetch_media_resource", {
    url,
    headers,
    maxBytes: maxBytes ?? null,
  });
}

/**
 * Identifies what container an address actually serves, from its leading bytes.
 *
 * Returns null outside the desktop runtime, where the command is not registered. Callers must treat
 * that as "no evidence" rather than "not FLV": the browser preview has no way to ask, and guessing
 * there would be exactly the mistake this command exists to remove.
 */
export async function probeMediaContainer(
  url: string,
  headers: Record<string, string> = {},
) {
  if (!isTauriRuntime()) return null;
  return invokeCommand<MediaContainerProbe>("probe_media_container", {
    url,
    headers,
  });
}

/**
 * Streams a live media response as it arrives, instead of buffering it to completion.
 *
 * A live body never ends, so `fetchMediaResource` cannot serve one: reqwest applies its timeout to
 * the whole body and reports the resulting expiry as "error decoding response body". This returns a
 * handle whose `cancel()` stops the upstream request.
 */
export async function streamMediaResource(
  streamId: string,
  url: string,
  headers: Record<string, string>,
  onChunk: (chunk: Uint8Array) => void,
  onMeta?: (meta: MediaStreamMeta) => void,
  onError?: (message: string) => void,
) {
  if (!isTauriRuntime()) return null;
  const channel = new Channel<Uint8Array | MediaStreamMeta>();
  channel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) {
      onChunk(new Uint8Array(message));
      return;
    }
    if (message instanceof Uint8Array) {
      onChunk(message);
      return;
    }
    // The command sends metadata as a JSON string, which arrives as a plain string.
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message) as MediaStreamMeta;
        if (parsed && parsed.kind === "meta") onMeta?.(parsed);
      } catch {
        // A payload that is neither bytes nor metadata is not actionable; dropping it keeps the
        // media path running rather than tearing playback down over a diagnostic message.
      }
      return;
    }
    if (message && typeof message === "object" && message.kind === "meta") {
      onMeta?.(message);
    }
  };
  const finished = invoke<void>("stream_media_resource", {
    streamId,
    url,
    headers,
    channel,
  }).catch((error: unknown) => {
    onError?.(error instanceof Error ? error.message : String(error));
  });
  return {
    cancel: async () => {
      await invokeCommand<void>("cancel_media_stream", { streamId });
      await finished;
    },
  };
}

/**
 * Probes every candidate line at once and returns them ordered with the usable ones first
 * (fastest response leading). Returns null outside the desktop runtime, where the command is
 * not registered.
 */
export async function probeStreamUrls(urls: string[], timeoutMs?: number) {
  if (!isTauriRuntime()) return null;
  return invokeCommand<StreamProbe[]>("probe_stream_urls", {
    urls,
    timeoutMs: timeoutMs ?? null,
  });
}

export async function listScriptExecutionLogs(limit = 20) {
  return invokeCommand<ScriptExecutionLog[]>("list_script_execution_logs", {
    limit,
  });
}

export async function listScriptArchives() {
  return invokeCommand<ScriptArchiveSummary[]>("list_script_archives");
}

export async function saveScriptArchive(input: SaveScriptArchiveInput) {
  return invokeCommand<ScriptArchiveSummary>("save_script_archive", { input });
}

export async function setScriptArchiveEnabled(id: number, enabled: boolean) {
  return invokeCommand<ScriptArchiveSummary>("set_script_archive_enabled", {
    archiveId: id,
    enabled,
  });
}

export async function deleteScriptArchive(id: number) {
  return invokeCommand<ScriptArchiveSummary[]>("delete_script_archive", {
    archiveId: id,
  });
}

export async function restoreScriptArchive(id: number) {
  return invokeCommand<ScriptArchiveSummary[]>("restore_script_archive", {
    archiveId: id,
  });
}

export async function purgeScriptArchive(id: number) {
  return invokeCommand<ScriptArchiveSummary[]>("purge_script_archive", {
    archiveId: id,
  });
}

export async function executeScriptArchive(
  id: number,
  input: unknown,
  entry?: string,
) {
  return invokeCommand<ScriptExecutionResult>("execute_script_archive", {
    archiveId: id,
    input,
    entry: entry ?? null,
  });
}

export interface SavedImage {
  path: string;
  bytes: number;
}

/**
 * Saves an image to a location the user picks.
 *
 * Resolves to `null` when the dialog was dismissed, which is an ordinary outcome rather than a
 * failure — the caller should stay quiet rather than reporting an error. Outside the desktop
 * runtime there is no native picker, so this also resolves to `null` instead of pretending to
 * have saved something.
 */
export async function downloadImage(url: string, fileName: string) {
  return invokeCommand<SavedImage | null>("download_image", { url, fileName });
}

async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
) {
  if (!isTauriRuntime()) return null;
  return invoke<T>(command, args);
}
