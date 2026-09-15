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
}

export interface PlaybackResolution {
  url: string;
  mediaKind: "hls" | "mp4" | "unknown";
  adapterId: string;
  parseServiceId?: string | null;
}

export interface ScriptExecutionRequest {
  script: string;
  entry?: string;
  input?: unknown;
  httpHosts?: string[];
}

export interface ScriptExecutionResult {
  value: unknown;
  adapterId: string;
  httpCallCount: number;
}

export interface SaveScriptArchiveInput {
  name: string;
  fileName: string;
  script: string;
  entry?: string;
  httpHosts?: string[];
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
    source.sourceType === "live" ? "test_live_source" : "test_source";
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

export async function executeScriptArchive(id: number, input: unknown) {
  return invokeCommand<ScriptExecutionResult>("execute_script_archive", {
    archiveId: id,
    input,
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
