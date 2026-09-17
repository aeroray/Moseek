import type { MediaKind } from "@/types/moseek";

/**
 * Guesses a media kind from the URL.
 *
 * Only the extension is inspected, so an address with no extension (a live channel behind an
 * opaque path, or a parser endpoint) returns "unknown" — which is the honest answer, and lets the
 * caller decide from other evidence such as `isLive`.
 */
export function inferMediaKind(url: string): MediaKind {
  const normalizedUrl = url.toLowerCase();
  if (normalizedUrl.includes(".m3u8")) return "hls";
  if (normalizedUrl.includes(".mp4")) return "mp4";
  return "unknown";
}
