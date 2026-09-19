/**
 * How far Moseek can go with a source.
 *
 * There is deliberately no "partial". It used to exist and was removed because nothing could ever
 * produce it: the parser assigns only these four, and no adapter profile claims partial execution.
 * It survived only in stored data written by an older version, where the config centre rendered it
 * as 部分支持 next to an adapter badge reading 没有可用适配器 — a row that said both "partly works"
 * and "there is nothing to run it". A status the code cannot produce is a status the user cannot
 * act on, so the state was deleted rather than reworded.
 */
export type CapabilityStatus =
  | "supported"
  | "needs-adapter"
  | "blocked"
  | "invalid";

export type SourceTestStatus =
  | "untested"
  | "passed"
  | "empty"
  | "failed"
  | "blocked";

export type SourceType = "cms" | "live" | "parser";

export type SourceDialect = "tvbox" | "kitty" | "mixed";

export type SourceOperationStatus =
  | "passed"
  | "empty"
  | "failed"
  | "blocked"
  | "skipped";

export interface SourceOperationResult {
  operation: string;
  status: SourceOperationStatus;
  message: string;
  durationMs: number;
}

export interface ParseServiceRecord {
  key: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown> | null;
  enabled: boolean;
  capability: CapabilityStatus;
  capabilityNote: string;
}

export interface ScriptArchiveSummary {
  id: number;
  name: string;
  fileName: string;
  sha256: string;
  entry: string;
  httpHosts: string[];
  httpHeaderNames: string[];
  moduleNames: string[];
  hasCookie: boolean;
  enabled: boolean;
  importedAt: string;
  lastUsedAt?: string | null;
}

export type SiteProtocol =
  | "xml-http"
  | "json-http"
  | "js-extension"
  | "html-http"
  | "xbpq"
  | "spider"
  | "http-extension"
  | "unknown";

export type ViewKey =
  | "browse"
  | "live"
  | "favorites"
  | "history"
  | "config"
  | "settings";

export type ThemeMode = "system" | "light" | "dark";

export type CatalogViewMode = "grid" | "list";

export type MediaKind = "hls" | "mp4" | "unknown";

export interface VodCategory {
  id: string;
  name: string;
}

export interface VodEpisode {
  id: string;
  name: string;
  url: string;
}

export interface VodPlayLine {
  id: string;
  name: string;
  episodes: VodEpisode[];
}

export interface VodItem {
  id: string;
  sourceKey: string;
  sourceName: string;
  name: string;
  poster: string;
  description: string;
  year: string;
  area: string;
  categories: VodCategory[];
  actors: string[];
  directors: string[];
  playLines: VodPlayLine[];
}

export interface CatalogPage {
  sourceKey: string;
  items: VodItem[];
  categories: VodCategory[];
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
}

/**
 * One thing that was watched, as a self-contained snapshot.
 *
 * The work is stored whole rather than by reference so the timeline keeps working after a source
 * is renamed or deleted — a footprint is a record of something that happened, and it must not
 * disappear because the place it happened moved.
 */
export interface VodFootprint {
  kind: "vod";
  id: string;
  item: VodItem;
  lineId: string;
  episodeId: string;
  episodeName: string;
  progress: number;
  updatedAt: string;
}

/**
 * A channel that was watched.
 *
 * Separate from the VOD shape rather than forced into it: a channel has no episodes, no line and
 * no resume position, and pretending otherwise would mean every consumer branching on fields that
 * are meaningless for half the records.
 */
export interface LiveFootprint {
  kind: "live";
  id: string;
  channel: LiveChannel;
  sourceName: string;
  updatedAt: string;
}

export type FootprintRecord = VodFootprint | LiveFootprint;

/** Which column a footprint belongs to, for actions that act on one kind at a time. */
export type FootprintKind = FootprintRecord["kind"];

export interface LiveGroup {
  id: string;
  name: string;
}

export interface LiveChannel {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  logoUrl: string;
  streamUrl: string;
  streamUrls: string[];
  mediaKind: MediaKind;
  sourceKey: string;
  epgId?: string;
}

/**
 * Where the user left off in a favourite.
 *
 * Stored with the favourite rather than looked up in `history`, because history is capped at 100
 * entries and is cleared independently — a favourite must keep its own place, or the very thing
 * that makes it worth favouriting is lost.
 */
export interface FavoriteProgress {
  lineId: string;
  episodeId: string;
  episodeName: string;
  /** Seconds into the episode. */
  seconds: number;
  /** Total episodes the work had when this was recorded, so an update is detectable. */
  episodeCount: number;
  updatedAt: string;
}

/**
 * A favourited work, stored as a self-contained snapshot.
 *
 * The whole `VodItem` is kept, including its play lines and episode URLs, so opening a favourite
 * does not depend on the source it came from: sources get renamed, reordered and deleted, and a
 * favourite that only stored a key would break the moment that happened. This is also what makes
 * the work's episodes available immediately, without a round trip before the player can start.
 */
export interface VodFavorite {
  /** `${sourceKey}:${itemId}`. Item ids are only unique within a source. */
  key: string;
  item: VodItem;
  /** The source it was saved from, for display and for relinking when it disappears. */
  sourceKey: string;
  sourceName: string;
  savedAt: string;
  progress: FavoriteProgress | null;
}

/**
 * A favourited channel, also self-contained: name, logo and every stream URL are captured at the
 * moment of favouriting, so the channel plays from the favourites page even if its source is
 * later deleted or reordered.
 */
export interface LiveFavorite {
  /** The channel id, which is already namespaced by source. */
  key: string;
  channel: LiveChannel;
  sourceKey: string;
  sourceName: string;
  savedAt: string;
}

export interface LiveCatalog {
  channels: LiveChannel[];
  groups: LiveGroup[];
}

export interface EpgProgram {
  id: string;
  channelId: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
}

export interface EpgCatalog {
  programs: EpgProgram[];
}

export interface SourceRecord {
  key: string;
  name: string;
  sourceType: SourceType;
  scriptArchiveId?: number | null;
  sourceDialect?: SourceDialect | null;
  siteType?: number | null;
  siteProtocol?: SiteProtocol | null;
  api: string;
  logo?: string;
  description?: string;
  nsfw?: boolean;
  status?: boolean;
  ext?: string;
  extra?: string;
  jar?: string;
  epg?: string;
  searchable: boolean;
  filterable: boolean;
  capability: CapabilityStatus;
  capabilityNote: string;
  testStatus?: SourceTestStatus;
  testMessage?: string;
  testedAt?: string;
  testItemCount?: number;
  testCategoryCount?: number;
  testDurationMs?: number;
  testOperations?: SourceOperationResult[];
  enabled: boolean;
  lastCheckedAt: string;
  requestCount: number;
}

export interface SourceTestResult {
  sourceKey: string;
  status: Exclude<SourceTestStatus, "untested">;
  adapterId: string;
  message: string;
  itemCount: number;
  categoryCount: number;
  durationMs: number;
  testedAt: string;
  operations: SourceOperationResult[];
}

export interface RecentPlay {
  title: string;
  source: string;
  progress: number;
  duration: string;
  poster: string;
  updatedAt: string;
}

export interface ActivityRecord {
  id: string;
  action: string;
  target: string;
  detail: string;
  status: "success" | "warning" | "error";
  time: string;
}
