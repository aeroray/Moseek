import type { MediaKind } from "@/types/moseek";

/**
 * Which playback pipeline a source must use.
 *
 * hls.js cannot play FLV: it parses the response as an HLS playlist, so an FLV stream handed to it
 * fails as "manifestLoadError / error decoding response body" — which names the wrong problem
 * entirely. mpegts.js is the maintained successor to flv.js and is what actually demuxes HTTP-FLV.
 */
export type MediaPipeline = "hls" | "flv" | "native";

/**
 * Evidence about an address that the URL alone cannot carry.
 *
 * `container` comes from the Rust `probe_media_container` command, which reads the leading bytes of
 * the *final* address after redirects. It is the only trustworthy signal here; see
 * `resolveMediaPipeline` for why each of the others is insufficient on its own.
 */
export interface MediaContainerEvidence {
  container: "flv" | "mpegts" | "hls" | "html" | "unknown";
  /** The address the probe finally landed on, after redirects. */
  url: string;
}

function looksLikeFlvUrl(url: string) {
  const normalized = url.toLowerCase();
  // The query string is stripped first: several CDNs append the real name as a parameter
  // (`/live/stream?name=1.flv`), and matching the whole string would also accept a URL whose
  // *query* merely mentions `.flv` while the path is something else entirely.
  const path = normalized.split(/[?#]/, 1)[0];
  return path.endsWith(".flv");
}

/**
 * Decides the pipeline for a source, preferring measured evidence over the address.
 *
 * The order of these checks is the whole point, so each one is here for a reason:
 *
 * 1. **A probed container wins outright.** It is the only signal derived from the bytes actually
 *    served, after following the same redirects the player will follow. It is also the only one
 *    that can catch the case this was built for: `https://live.ottiptv.cc/douyu/431460` names no
 *    extension at all and only becomes an FLV two redirects later, so nothing about the requested
 *    address could have predicted it.
 * 2. **An explicit `.flv` address is treated as FLV even before the probe answers.** The player
 *    starts on the address it was given, and waiting for a probe would mean handing an FLV to
 *    hls.js for as long as the probe takes. A `.flv` path is unambiguous enough to act on.
 * 3. **An mp4 is never FLV or HLS**, matching `usesHlsPipeline`: forcing a live mp4 through hls.js
 *    downloaded the whole file and then failed on the size limit instead of playing it.
 * 4. **Otherwise the existing rule stands**, so HLS behaviour is unchanged.
 *
 * A probed container of `html` deliberately does not change the pipeline. Several IPTV addresses
 * answer 200 with a landing page, and hls.js already reports "not a valid HLS playlist" for that,
 * which is a more accurate description than anything this function could substitute.
 */
export function resolveMediaPipeline(
  kind: MediaKind,
  isLive: boolean,
  url: string,
  evidence?: MediaContainerEvidence | null,
): MediaPipeline {
  if (evidence?.container === "flv") return "flv";
  // A final URL that differs from the requested one is evidence in itself: it is where the stream
  // actually lives, so an FLV ending there is decisive even if the requested address hid it.
  if (evidence && looksLikeFlvUrl(evidence.url)) return "flv";
  if (looksLikeFlvUrl(url)) return "flv";
  if (kind === "mp4") return "native";
  if (isLive || kind === "hls" || url.toLowerCase().includes(".m3u8")) return "hls";
  return "native";
}

/** Whether a pipeline is driven by hls.js. Exported so callers can key a player on the decision. */
export function usesHlsPipeline(
  kind: MediaKind,
  isLive: boolean,
  url: string,
  evidence?: MediaContainerEvidence | null,
) {
  return resolveMediaPipeline(kind, isLive, url, evidence) === "hls";
}

/**
 * Whether this source needs its container measured before the pipeline can be trusted.
 *
 * Only the genuinely ambiguous case is probed: a live address that carries no decisive extension.
 * That is the common shape for IPTV — the channel this was diagnosed on is a bare `/douyu/431460` —
 * but it is *not* the common answer, because most such addresses really are HLS. Probing is a
 * network round trip (measured at 1 596 ms for 64 KiB on the real channel), so it is deliberately
 * not awaited before playback starts; see `MediaPlayer`, which boots on the URL-derived guess and
 * switches only if the measurement contradicts it.
 *
 * A VOD address is never probed: an unknown non-live address is handled natively, and adding a
 * round trip to every episode load would buy nothing.
 */
export function shouldProbeContainer(
  kind: MediaKind,
  isLive: boolean,
  url: string,
) {
  if (!isLive) return false;
  if (kind === "mp4") return false;
  if (looksLikeFlvUrl(url)) return false;
  if (kind === "hls" || url.toLowerCase().includes(".m3u8")) return false;
  return true;
}
