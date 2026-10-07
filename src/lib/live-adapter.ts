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
 * The guide providers this app knows how to talk to, best first.
 *
 * Both answer the same per-channel JSON shape and both are free community services, so they are
 * interchangeable — which is what makes a fallback possible at all.
 *
 * **Ordered by reachability, measured rather than assumed.** `epg.112114.xyz` was the sole default and
 * is unreachable from the reporting machine: its DNS resolves to a different wrong address on every
 * lookup (a Dropbox range, then two Facebook ranges, then a Tencent answer of `202.160.130.52`), and
 * connecting straight to its real Cloudflare address fails too. 51zmt answered in 0.11 s over the same
 * connection. Sixteen of the reporter's eighteen live sources therefore failed every time: ten declare
 * no `epg` and so used this default, and six name 112114 explicitly.
 *
 * 51zmt covers what these playlists actually carry — measured on its endpoint, `CCTV1`, `CCTV5+`,
 * `CCTV13`, 湖南卫视, 浙江卫视, 东方卫视, 广东卫视 and 江苏卫视 all return real schedules — so it is a
 * sound default and not merely a reachable one.
 */
export const KNOWN_EPG_TEMPLATES = [
  "http://epg.51zmt.top:8000/api/diyp/?ch={name}&date={date}",
  "https://epg.112114.xyz/?ch={name}&date={date}",
] as const;

/**
 * Built-in fallback guide.
 *
 * Most public IPTV lists ship no `epg` field, and asking a non-technical user to hand-edit a
 * TVBox `epg` template is not a reasonable step: the guide is display-only enrichment that
 * never affects playback, so its absence should not cost a trip to the configuration editor.
 *
 * It is a best-effort default, not a guarantee: a channel the provider does not carry is
 * reported as unlisted rather than faked, and a source may always override it by declaring
 * its own `epg`.
 */
export const DEFAULT_EPG_TEMPLATE = KNOWN_EPG_TEMPLATES[0];

/**
 * The titles providers use as filler when they do not carry a channel.
 *
 * **Matched as a prefix, not by equality, and that is the fix.** 112114 answers HTTP 200 with a dozen
 * identical `精彩节目` rows for any channel it does not know — including obvious nonsense. 51zmt does
 * the same thing with a longer string: `精彩节目-暂未提供节目预告信息 --免费使用`. The check here used to
 * be `title === "精彩节目"`, which the 51zmt rows never satisfy, so the filler was accepted as a real
 * guide and every row on screen read "exciting programming — no schedule provided". Rendering filler
 * is worse than admitting the channel is not covered: it tells the user the guide works.
 *
 * The two providers also disagree on the channel-name field (`channel_name: "未提供"` versus a real
 * name), so the titles are the only signal that generalises. A prefix match keeps the check honest for
 * both without enumerating every wording a provider might add later.
 */
const PLACEHOLDER_TITLES = ["精彩节目", "暂未提供", "未提供"] as const;

/**
 * Whether a guide is entirely filler.
 *
 * Deliberately "entirely": a real guide can legitimately contain a programme whose title starts with
 * one of these words, and rejecting a whole day's schedule over one row would lose the rest of it. The
 * providers pad a whole response, so requiring every row to match is both safer and sufficient.
 */
export function isPlaceholderGuide(programs: EpgProgram[]) {
  return (
    programs.length > 0 &&
    programs.every((program) => {
      const title = program.title.trim();
      return PLACEHOLDER_TITLES.some((filler) => title.startsWith(filler));
    })
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
 *
 * **The name is also normalised for the providers that need it.** 51zmt keys on a compact form:
 * measured, `CCTV1` and `cctv1` return the real schedule for `CCTV-1综合`, while `CCTV-1`, `CCTV 1`,
 * `CCTV1综合` and `CCTV1高清` all return the "未提供" placeholder. A playlist that writes `CCTV-1` —
 * which is the usual spelling in the wild, and what the user reported — therefore got no guide for
 * CCTV-1 at all. `normalizeEpgChannelName` produces the compact form and `loadEpg` falls back to it
 * when the literal name yields nothing.
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
 * The compact channel spelling some guide providers key on, or null when there is nothing to change.
 *
 * Only the CCTV family is normalised, and only in the ways measured to matter: strip the separator
 * (`CCTV-1` → `CCTV1`), the space (`CCTV 1` → `CCTV1`), and a trailing quality marker
 * (`CCTV1高清` → `CCTV1`). The `+` is kept because it is part of the name — `CCTV5+` is a different
 * channel from `CCTV5`, and 51zmt lists it as `CCTV-5+体育赛事`.
 *
 * **Returns null when nothing would change**, so a caller can tell "no alternative to try" from
 * "try this instead" and avoid a duplicate request for every channel that is already correct. A name
 * that is not in the CCTV family is left alone: guessing at other providers' spellings without
 * measurement is how a working lookup gets broken.
 */
export function normalizeEpgChannelName(name: string): string | null {
  const trimmed = name.trim();
  const match = /^cctv[\s-]*(\d+\+?)/i.exec(trimmed);
  if (!match) return null;
  const compact = `CCTV${match[1]}`;
  return compact.toLowerCase() === trimmed.toLowerCase() ? null : compact;
}

/**
 * Guides are requested per channel, so flicking through the list otherwise re-fetches the
 * same day repeatedly. The date is part of the resolved URL, so entries go stale on their
 * own and the cache needs no expiry sweep — only a size bound.
 */
const epgCache = new Map<string, EpgCatalog>();
const EPG_CACHE_LIMIT = 64;

/**
 * Whether a guide URL is requested per channel, rather than being one address for every channel.
 *
 * A template (`?ch={name}&date={date}`) is asked about exactly one channel; a fixed URL is an XMLTV
 * document covering many. The distinction decides whether the returned programmes may be filtered by
 * channel identity at all — see `loadEpg`.
 */
export function isPerChannelTemplate(template: string) {
  return template.includes("{");
}

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
  /**
   * The templates to try, in order: the one asked for, then any other known provider.
   *
   * **Why a source's own `epg` is not the end of the story.** Six of the reporter's live sources name
   * `epg.112114.xyz` explicitly, and that host is unreachable from their network (see
   * `KNOWN_EPG_TEMPLATES`). Honouring the configured template and then giving up meant those channels
   * could never show a guide, even though a working provider for exactly the same channel names was
   * one request away. The configured provider still wins whenever it answers — the fallback only runs
   * after it has failed — so a user who deliberately points at their own guide keeps it.
   *
   * A fixed XMLTV URL is never swapped: it is one document in someone else's format, and substituting
   * a per-channel template for it would ask an unrelated question.
   */
  const candidates = isPerChannelTemplate(request.template)
    ? [
        request.template,
        ...KNOWN_EPG_TEMPLATES.filter((known) => known !== request.template),
      ]
    : [request.template];

  let firstFailure: EpgAdapterResult | null = null;
  for (const template of candidates) {
    const attempt = await requestGuide({ ...request, template }, channel);
    if (attempt.mode === "remote") return attempt;
    // Only a guide that came back *empty or as filler* is worth trying elsewhere.
    //
    // **A failed request is not, and the first version of this retried it.** `mode` is `empty` for
    // both "the provider answered with nothing" and "the request threw", so an unreachable host — the
    // very case being fixed — was asked a second time and the user waited out the timeout twice before
    // being told it failed. `error` is what distinguishes them.
    if (attempt.error !== null) {
      firstFailure ??= attempt;
      continue;
    }


    /**
     * One retry with the compact spelling: measured, `CCTV-1` returns the "未提供" filler while
     * `CCTV1` returns the real schedule, and a playlist's own spelling should not decide this.
     *
     * **Only for a per-channel template.** A fixed XMLTV address has no `{name}` to substitute, so
     * "retrying with a different spelling" resolves to the identical URL — the same address requested
     * twice for one channel. Measured: a fixed URL returning nothing produced two calls. The check is on
     * the template rather than on the candidate list, because the candidate is the configured URL on the
     * first pass whether or not it is a template.
     */
    const alternative = isPerChannelTemplate(template)
      ? normalizeEpgChannelName(channel.epgId?.trim() || channel.name?.trim() || "")
      : null;
    if (alternative !== null) {
      /**
       * The retry is made under the compact name but the programmes are **claimed under the channel's
       * own name**, and that distinction is the whole point.
       *
       * `requestGuide` labels a per-channel guide with the channel it was given. Passing the
       * substituted name straight through would label them `CCTV1` — while the live view filters by the
       * channel the user selected, `CCTV-1`, so the retry would fetch the right schedule and then have
       * every row dropped on the client. That is the same failure the claiming step exists to fix,
       * reintroduced one level down.
       */
      const retry = await requestGuide(
        { ...request, template },
        // The `epgId` would otherwise win inside `resolveEpgUrl` and re-send the name that just failed.
        { name: alternative, epgId: undefined },
        channel,
      );
      if (retry.mode === "remote") return retry;
    }

    // This provider answered but does not carry the channel. Another one might.
    firstFailure ??= attempt;
  }

  // Nothing worked. The first answer is reported rather than the last: it is the one the user's own
  // configuration asked for, so its message describes the thing they chose.
  return firstFailure ?? { data: { programs: [] }, mode: "empty", origin: request.origin, error: null };
}

/**
 * One guide request for one channel spelling, with its own cache entry.
 *
 * `identity` is the channel the result is attributed to, which is not always the spelling that was
 * requested — see the retry in `loadEpg`.
 */
async function requestGuide(
  request: EpgRequest,
  channel: Pick<LiveChannel, "name" | "epgId">,
  identity: Pick<LiveChannel, "name" | "epgId"> = channel,
): Promise<EpgAdapterResult> {
  const { origin } = request;
  const url = resolveEpgUrl(request.template, channel);
  const cacheKey = `${url}\u0000${new Date().toDateString()}`;
  const cached = epgCache.get(cacheKey);
  if (cached) return { data: { programs: claimPrograms(cached.programs, request.template, identity) }, mode: "remote", origin, error: null };
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
    const catalog = { programs: claimPrograms(programs, request.template, identity) };
    if (epgCache.size >= EPG_CACHE_LIMIT) {
      const oldest = epgCache.keys().next().value;
      if (oldest !== undefined) epgCache.delete(oldest);
    }
    // Cache the provider's data, since the same URL can be requested under different channel aliases.
    epgCache.set(cacheKey, { programs });
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

/**
 * Re-labels a per-channel guide's programmes with the channel they were requested for.
 *
 * **This is what made a working request show "暂无节目单".** The guide is asked about one channel, and
 * the provider answers with *its own* name for it — 51zmt answers a request for `CCTV1` with
 * `channel_name: "CCTV-1综合"`. The live view then filters the programmes by the channel's own
 * identifiers (`epgId`, `name`, `id`), none of which is `CCTV-1综合`, so every programme was discarded
 * on the client and the panel said the guide was empty while the request had in fact succeeded.
 *
 * The provider's name is not something the client can predict: it differs per provider, and it is the
 * provider's own canonical spelling rather than the playlist's. Since a template response contains
 * exactly one channel by construction, the honest reading is "these programmes are this channel's" —
 * so they are claimed for it rather than matched against it.
 *
 * A fixed URL is left alone: it genuinely covers many channels, and re-labelling it would attribute
 * every channel's programmes to whichever one happened to be selected.
 */
function claimPrograms(
  programs: EpgProgram[],
  template: string,
  channel: Pick<LiveChannel, "name" | "epgId">,
): EpgProgram[] {
  if (!isPerChannelTemplate(template)) return programs;
  const identity = channel.name.trim() || channel.epgId?.trim();
  if (!identity) return programs;
  // Re-keyed as well as re-labelled: `id` is derived from `channel_id` by the Rust parser, so leaving
  // it would make two channels' guides collide in any map keyed by programme id.
  return programs.map((program, index) => ({
    ...program,
    id: `${identity}-${index}`,
    channelId: identity,
  }));
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

/**
 * The next programme to start, or null once the guide's day is over.
 *
 * A guide carries only `HH:MM`, so a programme starting at 00:13 is genuinely "later tonight"
 * when it is 23:43 — but 13 sorts before 1423, so comparing start times numerically discarded
 * every programme after midnight and the footer claimed nothing was coming while one was half an
 * hour away.
 *
 * The reliable signal is the programme airing now: when it wraps past midnight, whatever starts
 * exactly when it ends is the next one. Wrapping unconditionally to the day's earliest programme
 * would be wrong instead — at 23:30 a guide that ends at noon has nothing left to show, and
 * offering its 01:08 entry as "稍后" would name a programme that already aired today.
 */
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
  if (next) return next;

  // Nothing starts later today. If the current programme runs past midnight, the schedule
  // continues into tomorrow, and the programme beginning at its end is the next one.
  const current = findCurrentProgram(programs, now);
  if (!current) return null;
  const currentStart = parseClock(current.startAt);
  const currentEnd = parseClock(current.endAt);
  if (currentStart === null || currentEnd === null) return null;
  if (currentEnd > currentStart) return null;
  return (
    programs.find((program) => parseClock(program.startAt) === currentEnd) ?? null
  );
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
