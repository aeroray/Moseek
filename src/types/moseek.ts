export type CapabilityStatus =
  | "supported"
  | "partial"
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

export interface PlayHistoryRecord {
  id: string;
  item: VodItem;
  lineId: string;
  episodeId: string;
  episodeName: string;
  progress: number;
  updatedAt: string;
}

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
