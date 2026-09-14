import { invoke } from "@tauri-apps/api/core";

import type { SourceRecord } from "@/types/moseek";

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
  return invokeCommand<string>("export_config", { documentId: documentId ?? null });
}

export async function fetchConfigUrl(url: string) {
  return invokeCommand<string>("fetch_config_url", { url });
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauriRuntime()) return null;
  return invoke<T>(command, args);
}
