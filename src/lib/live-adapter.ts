import { isTauriRuntime, loadLiveSource } from "@/lib/tauri";
import { getEpg } from "@/lib/tauri";
import type { EpgCatalog, SourceRecord, LiveCatalog } from "@/types/moseek";

export interface LiveAdapterResult {
  data: LiveCatalog;
  mode: "remote" | "empty";
  error: string | null;
}

export async function loadLiveCatalog(
  source?: SourceRecord,
): Promise<LiveAdapterResult> {
  if (source) {
    try {
      const remote = await loadLiveSource(source);
      if (remote) return { data: remote, mode: "remote", error: null };
    } catch (error) {
      return {
        data: { channels: [], groups: [] },
        mode: "remote",
        error: getErrorMessage(error, "直播源请求失败"),
      };
    }
  }
  return {
    data: { channels: [], groups: [] },
    mode: "empty",
    error: source
      ? isTauriRuntime()
        ? "直播请求未返回可解析频道"
        : "浏览器预览不会直接请求直播数据，请在 Tauri 桌面应用中使用此功能。"
      : null,
  };
}

export interface EpgAdapterResult {
  data: EpgCatalog;
  mode: "remote" | "empty";
  error: string | null;
}

export async function loadEpg(
  source?: SourceRecord,
): Promise<EpgAdapterResult> {
  if (source?.epg) {
    try {
      const remote = await getEpg(source.epg, "auto");
      if (remote) return { data: remote, mode: "remote", error: null };
    } catch (error) {
      return {
        data: { programs: [] },
        mode: "remote",
        error: getErrorMessage(error, "EPG 请求失败"),
      };
    }
  }
  return { data: { programs: [] }, mode: "empty", error: null };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return fallback;
}
