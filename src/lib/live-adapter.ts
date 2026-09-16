import { isTauriRuntime, loadLiveSource } from "@/lib/tauri";
import { getEpg } from "@/lib/tauri";
import type {
  EpgCatalog,
  LiveChannel,
  SourceRecord,
  LiveCatalog,
} from "@/types/moseek";

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

/**
 * TVBox `epg` entries are URL templates, not fixed URLs: `?ch={name}&date={date}` has to be
 * filled per channel. Sending the template verbatim makes the provider answer for the
 * literal string `{name}` (112114 replies with `channel_name: "{NAME}"` and a generic
 * "精彩节目" placeholder), so the guide looked like it had no data for any channel.
 */
export function resolveEpgUrl(
  template: string,
  channel?: Pick<LiveChannel, "name" | "epgId">,
  now: Date = new Date(),
) {
  if (!template.includes("{")) return template;
  const name = channel?.epgId?.trim() || channel?.name?.trim() || "";
  // 112114 keys on the local date, and its own docs use YYYY-MM-DD.
  const localDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return template
    .replace(/\{name\}/gi, encodeURIComponent(name))
    .replace(/\{date\}/gi, localDate)
    .replace(/\{epg_id\}/gi, encodeURIComponent(channel?.epgId?.trim() ?? ""))
    .replace(/\{id\}/gi, encodeURIComponent(channel?.epgId?.trim() ?? name));
}

/**
 * Fetches a guide from an already-resolved EPG URL. Callers resolve the TVBox template with
 * `resolveEpgUrl` first, because the resolved URL is what the fetch must be keyed on.
 */
export async function loadEpg(epgUrl?: string): Promise<EpgAdapterResult> {
  if (epgUrl?.trim()) {
    try {
      const remote = await getEpg(epgUrl, "auto");
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
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : "";
  if (message.includes("relative URL without a base")) {
    return "该直播源使用相对地址，请在配置中心补充原远程配置 URL 基址并重新保存。";
  }
  if (message.trim()) return message;
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
