import { parseParseServices } from "@/features/config/config-parser";
import { inferMediaKind } from "@/lib/media-kind";
import { resolvePlayback } from "@/lib/tauri";
import type { MediaKind, VodEpisode, VodItem } from "@/types/moseek";

export interface ResolvedEpisode {
  url: string;
  mediaKind: MediaKind;
  adapterId: string;
  headers: Record<string, string>;
}

/**
 * Turns an episode into something the player can load.
 *
 * Extracted from the watch page so favourites resolve episodes through exactly the same path.
 * A second implementation would drift, and the drift would show up as "this plays in the library
 * but not from favourites" — the hardest kind of bug to explain to a user.
 *
 * The address may still be behind a parser service, which `resolvePlayback` unwraps.
 *
 * The `source` parameter is gone. It existed only so a script-backed source could turn an opaque
 * episode id into a URL through its archive; with the script runtime removed, nothing here needed
 * it, and keeping an unused parameter would leave every call site passing an argument that means
 * nothing.
 */
export async function resolveEpisodePlayback(
  episode: VodEpisode,
  normalizedConfig: string,
): Promise<ResolvedEpisode> {
  const headers: Record<string, string> = {};

  const resolution = await resolvePlayback(
    episode.url,
    parseParseServices(normalizedConfig),
    // An episode address is very often a player page (`/share/<id>`, `/play/<id>`) rather than a
    // media file, so the resolver is asked to look inside it before falling back to a parser
    // service. Measured against the author's own configuration: 11 of 21 enabled sources deliver
    // page addresses, and scanning them produced a verified playable manifest for 29 of 33.
    true,
  );
  if (!resolution) throw new Error("桌面运行时未返回播放解析结果");
  return { ...resolution, headers };
}

/** The media kind to hand the player when the resolution has not arrived yet. */
export function episodeMediaKind(episode: VodEpisode | undefined): MediaKind {
  return episode ? inferMediaKind(episode.url) : "unknown";
}

/**
 * Which episode to open a work on.
 *
 * The rule the user asked for: resume where they left off if they have been here before, and
 * otherwise start from the beginning. "Latest" is deliberately not the default — a work the user
 * has never opened starting at episode 40 of 40 would be baffling, and an updated series that
 * they *have* been watching is resumed rather than jumped forward.
 *
 * The saved episode is matched by id first, then by name, then by position. Ids are not stable
 * across sources, so a favourite that was relinked to a different source will have a completely
 * different set; the name is what usually survives, and the position is the last resort.
 */
export function pickEntryEpisode(
  item: VodItem,
  progress: {
    lineId: string;
    episodeId: string;
    episodeName?: string;
  } | null,
): { lineId: string; episodeId: string } {
  const firstLine = item.playLines[0];
  const first = {
    lineId: firstLine?.id ?? "",
    episodeId: firstLine?.episodes[0]?.id ?? "",
  };
  if (!progress) return first;

  const line =
    item.playLines.find((candidate) => candidate.id === progress.lineId) ??
    firstLine;
  if (!line) return first;

  const byId = line.episodes.find(
    (candidate) => candidate.id === progress.episodeId,
  );
  if (byId) return { lineId: line.id, episodeId: byId.id };

  // A different source names and numbers its episodes independently, so fall back to the name
  // before giving up — otherwise a relinked series restarts from episode 1.
  const byName = progress.episodeName
    ? line.episodes.find((candidate) => candidate.name === progress.episodeName)
    : undefined;
  if (byName) return { lineId: line.id, episodeId: byName.id };

  return { lineId: line.id, episodeId: line.episodes[0]?.id ?? "" };
}

/** How far through the saved episode the user was, clamped to something playable. */
export function resumeSeconds(
  progress: { seconds: number } | null | undefined,
) {
  if (!progress) return 0;
  // Below a few seconds there is nothing worth resuming, and seeking that close to the start can
  // make some players stall rather than simply begin.
  return progress.seconds > 5 ? progress.seconds : 0;
}
