import type { FavoriteProgress, LiveChannel, LiveFavorite, VodFavorite, VodItem } from "@/types/moseek";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === "string")
  : [];
const entries = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.map(record).filter((entry) => entry !== null)
  : [];
const seconds = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Recover old snapshots while refusing shapes that cannot be rendered or played. */
export function normalizeVodItem(value: unknown, sourceKey = "", sourceName = ""): VodItem | null {
  const item = record(value);
  if (!item || typeof item.id !== "string" || !item.id || typeof item.name !== "string") return null;
  return {
    id: item.id, name: item.name,
    sourceKey: text(item.sourceKey, sourceKey), sourceName: text(item.sourceName, sourceName),
    poster: text(item.poster), description: text(item.description), year: text(item.year), area: text(item.area),
    categories: entries(item.categories).filter((entry) => typeof entry.id === "string" && typeof entry.name === "string")
      .map((entry) => ({ id: entry.id as string, name: entry.name as string })),
    actors: strings(item.actors), directors: strings(item.directors),
    playLines: entries(item.playLines).filter((line) => typeof line.id === "string" && typeof line.name === "string")
      .map((line) => ({
        id: line.id as string, name: line.name as string,
        episodes: entries(line.episodes).filter((episode) => typeof episode.id === "string" && typeof episode.name === "string" && typeof episode.url === "string")
          .map((episode) => ({ id: episode.id as string, name: episode.name as string, url: episode.url as string })),
      })),
  };
}

export function normalizeLiveChannel(value: unknown, sourceKey = ""): LiveChannel | null {
  const channel = record(value);
  if (!channel || typeof channel.id !== "string" || !channel.id || typeof channel.name !== "string") return null;
  const streamUrl = text(channel.streamUrl);
  return {
    id: channel.id, name: channel.name, sourceKey: text(channel.sourceKey, sourceKey),
    groupId: text(channel.groupId), groupName: text(channel.groupName), logoUrl: text(channel.logoUrl),
    streamUrl, streamUrls: Array.isArray(channel.streamUrls) ? strings(channel.streamUrls) : streamUrl ? [streamUrl] : [],
    mediaKind: channel.mediaKind === "hls" || channel.mediaKind === "mp4" ? channel.mediaKind : "unknown",
    ...(typeof channel.epgId === "string" ? { epgId: channel.epgId } : {}),
  };
}

function normalizeProgress(value: unknown): FavoriteProgress | null {
  const progress = record(value);
  if (!progress || typeof progress.lineId !== "string" || typeof progress.episodeId !== "string") return null;
  return {
    lineId: progress.lineId, episodeId: progress.episodeId, episodeName: text(progress.episodeName),
    seconds: seconds(progress.seconds), episodeCount: Math.floor(seconds(progress.episodeCount)), updatedAt: text(progress.updatedAt),
  };
}

export function normalizeVodFavorite(value: unknown): VodFavorite | null {
  const favorite = record(value);
  if (!favorite || typeof favorite.key !== "string" || !favorite.key) return null;
  const item = normalizeVodItem(favorite.item, text(favorite.sourceKey), text(favorite.sourceName));
  if (!item) return null;
  return {
    key: favorite.key, item, sourceKey: text(favorite.sourceKey, item.sourceKey), sourceName: text(favorite.sourceName, item.sourceName),
    savedAt: text(favorite.savedAt), progress: normalizeProgress(favorite.progress),
  };
}

export function normalizeLiveFavorite(value: unknown): LiveFavorite | null {
  const favorite = record(value);
  if (!favorite || typeof favorite.key !== "string" || !favorite.key) return null;
  const channel = normalizeLiveChannel(favorite.channel, text(favorite.sourceKey));
  if (!channel) return null;
  return {
    key: favorite.key, channel, sourceKey: channel.sourceKey, sourceName: text(favorite.sourceName), savedAt: text(favorite.savedAt),
  };
}
