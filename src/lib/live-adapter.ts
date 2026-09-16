import { isTauriRuntime, loadLiveSource } from "@/lib/tauri";
import { getEpg } from "@/lib/tauri";
import type {
  EpgCatalog,
  EpgProgram,
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

/**
 * Built-in fallback guide.
 *
 * Most public IPTV lists ship no `epg` field, and asking a non-technical user to hand-edit a
 * TVBox `epg` template is not a reasonable step: the guide is display-only enrichment that
 * never affects playback, so its absence should not cost a trip to the configuration editor.
 *
 * 112114 is a free community guide. Its per-channel JSON endpoint recognises the raw channel
 * names public lists actually carry (measured on a typical 央视/卫视 list: 38 of the first 40
 * names resolved without any normalisation, e.g. "sCCTV1综合" and "4CCTV3综艺" both matched
 * "CCTV1"/"CCTV3"). Its bulk XMLTV export covers fewer of those names (89/129) and costs
 * 2.6 MiB instead of 3.4 KiB, so the per-channel endpoint is what this default uses.
 *
 * It is a best-effort default, not a guarantee: a channel the provider does not carry is
 * reported as unlisted rather than faked, and a source may always override it by declaring
 * its own `epg`.
 */
export const DEFAULT_EPG_TEMPLATE = "https://epg.112114.xyz/?ch={name}&date={date}";

/**
 * 112114 answers HTTP 200 with a dozen identical "精彩节目" rows for any channel it does not
 * know — including obvious nonsense. That is indistinguishable from a real guide unless it is
 * rejected explicitly, and rendering it would tell the user the guide works while every row
 * reads "exciting programming", which is worse than admitting the channel is not covered.
 */
const PLACEHOLDER_PROGRAM_TITLE = "精彩节目";

export function isPlaceholderGuide(programs: EpgProgram[]) {
  return (
    programs.length > 0 &&
    programs.every(
      (program) => program.title.trim() === PLACEHOLDER_PROGRAM_TITLE,
    )
  );
}

export type EpgOrigin = "configured" | "auto";

export interface EpgRequest {
  template: string;
  origin: EpgOrigin;
}

/**
 * Chooses which guide template to use for a source. An explicitly configured `epg` always
 * wins; the built-in default is used only when the source declares none and the user has not
 * turned automatic guides off.
 */
export function resolveEpgRequest(
  source: Pick<SourceRecord, "epg"> | undefined,
  autoEpgEnabled: boolean,
): EpgRequest | null {
  const configured = source?.epg?.trim();
  if (configured) return { template: configured, origin: "configured" };
  if (autoEpgEnabled) return { template: DEFAULT_EPG_TEMPLATE, origin: "auto" };
  return null;
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
 * Guides are requested per channel, so flicking through the list otherwise re-fetches the
 * same day repeatedly. The date is part of the resolved URL, so entries go stale on their
 * own and the cache needs no expiry sweep — only a size bound.
 */
const epgCache = new Map<string, EpgCatalog>();
const EPG_CACHE_LIMIT = 64;

export interface EpgAdapterResult {
  data: EpgCatalog;
  /** `unrecognized` means the provider answered, but only with placeholder filler. */
  mode: "remote" | "empty" | "unrecognized";
  origin: EpgOrigin;
  error: string | null;
}

export async function loadEpg(
  request: EpgRequest,
  channel: Pick<LiveChannel, "name" | "epgId">,
): Promise<EpgAdapterResult> {
  const { origin } = request;
  const url = resolveEpgUrl(request.template, channel);
  const cached = epgCache.get(url);
  if (cached) return { data: cached, mode: "remote", origin, error: null };
  try {
    const remote = await getEpg(url, "auto");
    const programs = remote?.programs ?? [];
    if (programs.length === 0) {
      return { data: { programs: [] }, mode: "empty", origin, error: null };
    }
    if (isPlaceholderGuide(programs)) {
      // Deliberately not cached: a provider may list the channel later.
      return { data: { programs: [] }, mode: "unrecognized", origin, error: null };
    }
    const catalog = { programs };
    if (epgCache.size >= EPG_CACHE_LIMIT) {
      const oldest = epgCache.keys().next().value;
      if (oldest !== undefined) epgCache.delete(oldest);
    }
    epgCache.set(url, catalog);
    return { data: catalog, mode: "remote", origin, error: null };
  } catch (error) {
    return {
      data: { programs: [] },
      mode: "empty",
      origin,
      error: getErrorMessage(error, "EPG 请求失败"),
    };
  }
}

/** Parses the `HH:MM` clock the Rust parser emits for both XMLTV and JSON guides. */
function parseClock(value: string) {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Picks the programme airing right now. Providers return the whole day from 00:00, so the
 * first row is the earliest programme of the day rather than the current one — the workspace
 * used to label `programs[0]` "当前" and showed 01:08 while 11:48 was on air.
 */
export function findCurrentProgram(
  programs: EpgProgram[],
  now: Date = new Date(),
): EpgProgram | null {
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const program of programs) {
    const start = parseClock(program.startAt);
    const end = parseClock(program.endAt);
    if (start === null || end === null) continue;
    // A programme can run past midnight, in which case its end is numerically before its
    // start and the interval wraps.
    const airing =
      end <= start
        ? minutes >= start || minutes < end
        : minutes >= start && minutes < end;
    if (airing) return program;
  }
  return null;
}

/** The next programme to start, or null once the guide's day is over. */
export function findNextProgram(
  programs: EpgProgram[],
  now: Date = new Date(),
): EpgProgram | null {
  const minutes = now.getHours() * 60 + now.getMinutes();
  let next: EpgProgram | null = null;
  let nextStart = Number.POSITIVE_INFINITY;
  for (const program of programs) {
    const start = parseClock(program.startAt);
    if (start === null || start <= minutes) continue;
    if (start < nextStart) {
      nextStart = start;
      next = program;
    }
  }
  return next;
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
