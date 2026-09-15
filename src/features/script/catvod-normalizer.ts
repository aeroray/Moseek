import type {
  CatalogPage,
  VodCategory,
  VodEpisode,
  VodItem,
  VodPlayLine,
} from "@/types/moseek";

export type CatVodMethod =
  | "getCategory"
  | "getHome"
  | "getSearch"
  | "getDetail"
  | "parseIframe";

export interface CatVodNormalizeContext {
  sourceKey: string;
  sourceName: string;
  page?: number;
  pageSize?: number;
}

export interface CatVodPlaybackResult {
  url: string;
  headers: Record<string, string>;
}

export type CatVodNormalizedResult =
  | { kind: "categories"; value: VodCategory[] }
  | { kind: "catalog"; value: CatalogPage }
  | { kind: "detail"; value: VodItem | null }
  | { kind: "playback"; value: CatVodPlaybackResult | null };

export function normalizeCatVodResult(
  method: CatVodMethod,
  raw: unknown,
  context: CatVodNormalizeContext,
): CatVodNormalizedResult {
  switch (method) {
    case "getCategory":
      return { kind: "categories", value: normalizeCatVodCategories(raw) };
    case "getDetail":
      return {
        kind: "detail",
        value: normalizeCatVodDetail(raw, context),
      };
    case "parseIframe":
      return { kind: "playback", value: normalizeCatVodPlayback(raw) };
    case "getHome":
    case "getSearch":
      return {
        kind: "catalog",
        value: normalizeCatVodCatalog(raw, context),
      };
  }
}

export function normalizeCatVodCategories(raw: unknown): VodCategory[] {
  const values = unwrapCollection(raw, ["categories", "class", "data", "list"]);
  return values
    .map((value, index) => {
      if (typeof value === "string" || typeof value === "number") {
        return { id: String(index + 1), name: String(value).trim() };
      }
      const object = asObject(value);
      if (!object) return null;
      const name = text(object, ["name", "text", "title", "type_name"]);
      if (!name) return null;
      return {
        id: text(object, ["id", "key", "type_id"]) || String(index + 1),
        name,
      };
    })
    .filter((value): value is VodCategory => value !== null);
}

export function normalizeCatVodCatalog(
  raw: unknown,
  context: CatVodNormalizeContext,
): CatalogPage {
  const page = Math.max(1, context.page ?? 1);
  const pageSize = Math.max(1, context.pageSize ?? 20);
  const object = asObject(raw);
  const items = unwrapCollection(raw, [
    "list",
    "items",
    "results",
    "data",
    "vod",
    "videos",
  ])
    .map((value, index) =>
      normalizeVodItem(value, context, `${context.sourceKey}-${index + 1}`),
    )
    .filter((value): value is VodItem => value !== null);
  const total =
    numberValue(object, ["total", "totalCount", "recordcount", "count"]) ??
    items.length;
  const pageCount =
    numberValue(object, ["pageCount", "page_count", "pagecount"]) ??
    Math.max(1, Math.ceil(total / pageSize));
  return {
    sourceKey: context.sourceKey,
    items,
    categories: normalizeCatVodCategories(
      pick(object, ["categories", "class", "types"]),
    ),
    page,
    pageCount: Math.max(1, pageCount),
    pageSize,
    total,
  };
}

export function normalizeCatVodDetail(
  raw: unknown,
  context: CatVodNormalizeContext,
): VodItem | null {
  const item = unwrapCollection(raw, ["detail", "data", "result", "list"])[0];
  return normalizeVodItem(item ?? raw, context, `${context.sourceKey}-detail`);
}

export function normalizeCatVodPlayback(
  raw: unknown,
): CatVodPlaybackResult | null {
  const object = asObject(raw);
  const url =
    text(object, ["url", "playUrl", "play_url", "link", "result"]) ||
    (typeof raw === "string" ? raw.trim() : "");
  if (!url) return null;
  return {
    url,
    headers: scalarRecord(pick(object, ["headers", "header"])),
  };
}

function normalizeVodItem(
  raw: unknown,
  context: CatVodNormalizeContext,
  fallbackId: string,
): VodItem | null {
  const object = asObject(raw);
  if (!object) return null;
  const id = text(object, ["id", "vod_id", "key"]) || fallbackId;
  const name = text(object, ["title", "name", "vod_name"]);
  const playLines = normalizePlayLines(object);
  if (!name && playLines.length === 0) return null;
  return {
    id,
    sourceKey: context.sourceKey,
    sourceName: context.sourceName,
    name: name || id,
    poster: text(object, ["cover", "pic", "poster", "vod_pic"]),
    description: text(object, [
      "description",
      "desc",
      "content",
      "vod_content",
    ]),
    year: text(object, ["year", "vod_year"]),
    area: text(object, ["area", "vod_area"]),
    categories: normalizeItemCategories(
      pick(object, ["categories", "category", "class", "vod_class"]),
    ),
    actors: peopleValue(pick(object, ["actors", "actor", "vod_actor"])),
    directors: peopleValue(
      pick(object, ["directors", "director", "vod_director"]),
    ),
    playLines,
  };
}

function normalizeItemCategories(raw: unknown): VodCategory[] {
  if (typeof raw === "string") {
    return raw
      .split(/[/,|、]/)
      .map((name, index) => ({ id: `category-${index}`, name: name.trim() }))
      .filter((category) => category.name.length > 0);
  }
  return normalizeCatVodCategories(raw);
}

function normalizePlayLines(object: Record<string, unknown>): VodPlayLine[] {
  const playlist = pick(object, [
    "playlist",
    "playList",
    "play_lines",
    "playLines",
    "vod_play_url",
    "play_url",
    "episodes",
  ]);
  const names = splitLines(
    pick(object, ["vod_play_from", "play_from", "lines"]),
  );
  if (playlist === undefined || playlist === null) return [];
  const lines = toLineValues(playlist);
  return lines
    .map((line, index) => {
      const lineObject = asObject(line);
      const episodes = normalizeEpisodes(
        lineObject
          ? pick(lineObject, ["episodes", "list", "urls", "playUrl", "url"])
          : line,
      );
      if (episodes.length === 0) return null;
      return {
        id: `line-${index}`,
        name:
          (lineObject &&
            text(lineObject, ["name", "title", "from", "source"])) ||
          names[index] ||
          `线路 ${index + 1}`,
        episodes,
      };
    })
    .filter((line): line is VodPlayLine => line !== null);
}

function toLineValues(raw: unknown): unknown[] {
  if (typeof raw === "string") return splitLines(raw);
  if (Array.isArray(raw)) {
    if (
      raw.some((value) => {
        const object = asObject(value);
        return Boolean(
          object &&
          pick(object, ["episodes", "list", "urls", "playUrl", "url"]),
        );
      })
    ) {
      return raw;
    }
    return [{ episodes: raw }];
  }
  const object = asObject(raw);
  if (!object) return [];
  const nested = pick(object, ["lines", "playLines", "playlist"]);
  if (nested !== undefined) return toLineValues(nested);
  const entries = Object.entries(object);
  if (
    entries.length > 0 &&
    entries.every(
      ([, value]) => typeof value === "string" || Array.isArray(value),
    )
  ) {
    return entries.map(([name, value]) => ({ name, episodes: value }));
  }
  return [object];
}

function normalizeEpisodes(raw: unknown): VodEpisode[] {
  if (typeof raw === "string") {
    return raw
      .split("#")
      .map((value, index) => episodeFromString(value, index))
      .filter((episode): episode is VodEpisode => episode !== null);
  }
  if (!Array.isArray(raw)) {
    const object = asObject(raw);
    return object
      ? [episodeFromObject(object, 0)].filter(
          (episode): episode is VodEpisode => episode !== null,
        )
      : [];
  }
  return raw
    .flatMap((value, index) => {
      if (typeof value === "string") return [episodeFromString(value, index)];
      const object = asObject(value);
      return object ? [episodeFromObject(object, index)] : [];
    })
    .filter((episode): episode is VodEpisode => episode !== null);
}

function episodeFromString(value: string, index: number): VodEpisode | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separator = trimmed.includes("$")
    ? "$"
    : trimmed.includes("|")
      ? "|"
      : null;
  const [name, url] = separator ? splitOnce(trimmed, separator) : ["", trimmed];
  if (!url.trim()) return null;
  return {
    id: `episode-${index}`,
    name: name.trim() || `第 ${index + 1} 集`,
    url: url.trim(),
  };
}

function episodeFromObject(
  object: Record<string, unknown>,
  index: number,
): VodEpisode | null {
  const url = text(object, ["url", "playUrl", "play_url", "link", "id"]);
  if (!url) return null;
  return {
    id: text(object, ["id", "key"]) || `episode-${index}`,
    name: text(object, ["name", "title", "text"]) || `第 ${index + 1} 集`,
    url,
  };
}

function splitLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim());
  if (typeof value !== "string") return [];
  return value
    .split("$$$")
    .map((item) => item.trim())
    .filter(Boolean);
}

function peopleValue(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(/[/,|、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unwrapCollection(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const object = asObject(raw);
  if (!object) return [];
  for (const key of keys) {
    const value = object[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object")
      return unwrapCollection(value, keys);
  }
  return [raw];
}

function splitOnce(value: string, separator: string): [string, string] {
  const position = value.indexOf(separator);
  if (position < 0) return ["", value];
  return [value.slice(0, position), value.slice(position + separator.length)];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pick(object: Record<string, unknown> | null, keys: string[]): unknown {
  if (!object) return undefined;
  return keys.find((key) => object[key] !== undefined)
    ? object[keys.find((key) => object[key] !== undefined)!]
    : undefined;
}

function text(object: Record<string, unknown> | null, keys: string[]): string {
  const value = pick(object, keys);
  if (typeof value === "string" || typeof value === "number")
    return String(value).trim();
  return "";
}

function numberValue(
  object: Record<string, unknown> | null,
  keys: string[],
): number | null {
  const value = pick(object, keys);
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function scalarRecord(value: unknown): Record<string, string> {
  const object = asObject(value);
  if (!object) return {};
  return Object.entries(object).reduce(
    (result, [key, candidate]) => {
      if (
        typeof candidate === "string" ||
        typeof candidate === "number" ||
        typeof candidate === "boolean"
      ) {
        result[key] = String(candidate);
      }
      return result;
    },
    {} as Record<string, string>,
  );
}
