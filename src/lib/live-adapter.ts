import { getLiveChannels, isTauriRuntime } from "@/lib/tauri";
import { getEpg } from "@/lib/tauri";
import { mockLiveChannels, mockLiveGroups } from "@/lib/mock-live-data";
import { mockEpgPrograms } from "@/lib/mock-live-data";
import type { EpgCatalog, SourceRecord, LiveCatalog } from "@/types/moseek";

export interface LiveAdapterResult {
  data: LiveCatalog;
  mode: "remote" | "demo";
  error: string | null;
}

export async function loadLiveCatalog(
  source?: SourceRecord,
): Promise<LiveAdapterResult> {
  if (source) {
    try {
      const remote = await getLiveChannels(
        source.key,
        source.api,
        source.ext ?? "auto",
      );
      if (remote) return { data: remote, mode: "remote", error: null };
    } catch (error) {
      if (isTauriRuntime()) {
        return {
          data: { channels: [], groups: [] },
          mode: "remote",
          error: error instanceof Error ? error.message : "直播源请求失败",
        };
      }
    }
  }
  return {
    data: { channels: mockLiveChannels, groups: mockLiveGroups },
    mode: "demo",
    error: null,
  };
}

export interface EpgAdapterResult {
  data: EpgCatalog;
  mode: "remote" | "demo";
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
      if (isTauriRuntime()) {
        return {
          data: { programs: [] },
          mode: "remote",
          error: error instanceof Error ? error.message : "EPG 请求失败",
        };
      }
    }
  }
  return { data: { programs: mockEpgPrograms }, mode: "demo", error: null };
}
