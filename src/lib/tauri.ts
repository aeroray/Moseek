import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

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

export const DEFAULT_SNIFFER_COMPANION_URL = "http://127.0.0.1:57573/sniffer";

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadLatestConfig() {
  return invokeCommand<StoredConfigDocument | null>("load_latest_config");
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

export async function fetchConfigUrl(url: string) {
  return invokeCommand<string>("fetch_config_url", { url });
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

export async function testSource(source: SourceRecord) {
  const command =
    source.sourceType === "live"
      ? "test_live_source"
      : source.scriptArchiveId !== null && source.scriptArchiveId !== undefined
        ? "test_script_source"
        : "test_source";
  return invokeCommand<SourceTestResult>(command, {
    source,
  });
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

export async function resolvePlayback(
  url: string,
  parseServices: ParseServiceRecord[] = [],
) {
  return invokeCommand<PlaybackResolution>("resolve_playback", {
    url,
    parseServices,
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

export async function sniffWithCompanion(
  targetUrl: string,
  companionUrl = DEFAULT_SNIFFER_COMPANION_URL,
) {
  return invokeCommand<PlaybackResolution>("sniff_with_companion", {
    targetUrl,
    companionUrl,
    timeoutMs: 15_000,
  });
}

export async function executeScript(request: ScriptExecutionRequest) {
  return invokeCommand<ScriptExecutionResult>("execute_script", { request });
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

export async function openExternalUrl(
  url: string,
  parseServices: ParseServiceRecord[] = [],
) {
  const resolved = await resolvePlayback(url, parseServices);
  const targetUrl = resolved?.url ?? url;
  const parsedUrl = new URL(targetUrl);
  if (!matchesHttpProtocol(parsedUrl.protocol)) {
    throw new Error("只允许打开 HTTP 或 HTTPS 媒体地址");
  }
  if (isTauriRuntime()) {
    await openUrl(targetUrl);
    return;
  }
  window.open(targetUrl, "_blank", "noopener,noreferrer");
}

function matchesHttpProtocol(protocol: string) {
  return protocol === "http:" || protocol === "https:";
}

async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
) {
  if (!isTauriRuntime()) return null;
  return invoke<T>(command, args);
}
