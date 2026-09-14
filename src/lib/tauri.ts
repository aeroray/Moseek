import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import type {
  CatalogPage,
  EpgCatalog,
  LiveCatalog,
  SourceRecord,
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
}

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

export async function resolvePlayback(url: string) {
  return invokeCommand<PlaybackResolution>("resolve_playback", { url });
}

export async function openExternalUrl(url: string) {
  const resolved = await resolvePlayback(url);
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
