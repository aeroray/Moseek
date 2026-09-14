export type CapabilityStatus =
  | "supported"
  | "partial"
  | "needs-adapter"
  | "blocked"
  | "invalid";

export type SourceType = "cms" | "live" | "parser";

export type ViewKey =
  | "home"
  | "browse"
  | "live"
  | "favorites"
  | "history"
  | "config"
  | "settings";

export type ThemeMode = "system" | "light" | "dark";

export type CatalogViewMode = "grid" | "list";

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

export interface SourceRecord {
  key: string;
  name: string;
  sourceType: SourceType;
  api: string;
  ext?: string;
  jar?: string;
  searchable: boolean;
  filterable: boolean;
  capability: CapabilityStatus;
  capabilityNote: string;
  enabled: boolean;
  lastCheckedAt: string;
  requestCount: number;
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
