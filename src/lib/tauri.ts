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

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadLatestConfig() {
  return invokeCommand<StoredConfigDocument | null>("load_latest_config");
}

export async function saveConfigDocument(input: SaveConfigDocumentInput) {
  return invokeCommand<StoredConfigDocument>("save_config_document", { input });
}

export async function setSourceEnabled(sourceKey: string, enabled: boolean) {
  return invokeCommand<void>("set_source_enabled", { sourceKey, enabled });
}

export async function exportConfig(documentId?: number) {
  return invokeCommand<string>("export_config", {
    documentId: documentId ?? null,
  });
}

export async function fetchConfigUrl(url: string) {
  return invokeCommand<string>("fetch_config_url", { url });
}

export async function searchSource(
  sourceKey: string,
  api: string,
  query: string,
  categoryId: string,
  page: number,
  pageSize: number,
) {
  return invokeCommand<CatalogPage>("search_source", {
    sourceKey,
    api,
    query,
    categoryId,
    page,
    pageSize,
  });
}

export async function getSourceDetail(
  sourceKey: string,
  api: string,
  vodId: string,
) {
  return invokeCommand<VodItem | null>("get_source_detail", {
    sourceKey,
    api,
    vodId,
  });
}

export async function getLiveChannels(
  sourceKey: string,
  sourceUrl: string,
  format: string,
) {
  return invokeCommand<LiveCatalog>("get_live_channels", {
    sourceKey,
    sourceUrl,
    format,
  });
}

export async function getEpg(sourceUrl: string, format: string) {
  return invokeCommand<EpgCatalog>("get_epg", { sourceUrl, format });
}

export async function openExternalUrl(url: string) {
  const parsedUrl = new URL(url);
  if (!matchesHttpProtocol(parsedUrl.protocol)) {
    throw new Error("只允许打开 HTTP 或 HTTPS 媒体地址");
  }
  if (isTauriRuntime()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
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
