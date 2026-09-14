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
