import { cancelMediaRequest, fetchMediaResource, isTauriRuntime } from "@/lib/tauri";
import { imageDataUrl, isEmbeddedImage } from "@/components/policy-image";

/**
 * Candidate addresses for a poster, best-quality first.
 *
 * Sources publish a poster through whatever CDN they use, and the same artwork is frequently
 * available at more than one size: a listing often points at a thumbnail while the full image sits
 * at the same path without the resize parameters. There is no field that says which is which, so
 * the only honest way to get the high-definition image is to derive the plausible larger
 * addresses, load them, and keep the one that actually resolves to more pixels.
 *
 * These are candidates, not answers. Nothing here claims a URL is better; it only proposes
 * variants that a caller can test. A wrong guess costs one failed image load, and the original is
 * always the last entry, so the result is never worse than doing nothing.
 */
export function posterCandidates(url: string): string[] {
  const trimmed = url?.trim();
  if (!trimmed) return [];

  const candidates: string[] = [];
  const add = (value: string) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  // The original is the floor, never absent, and always last so a caller that stops at the first
  // success still ends up with something usable.
  const stripped = stripResizeParameters(trimmed);
  const unthumbled = stripThumbnailSuffix(stripped);

  add(unthumbled);
  add(stripped);
  add(trimmed);
  return candidates;
}

/**
 * Removes query parameters that ask the CDN to downscale.
 *
 * These are the most reliable signal: a URL carrying `?x-oss-process=image/resize,w_200` is
 * explicitly requesting a small render of a larger original, so dropping the parameter is very
 * likely to return the full image. Parameters that are not about resizing are left alone, because
 * they may be a signature or a cache key the CDN requires.
 */
function stripResizeParameters(url: string): string {
  const [base, query] = splitOnce(url, "?");
  if (!query) return url;

  const resizeMarkers = [
    "x-oss-process",
    "imageMogr2",
    "imageView",
    "resize",
    "thumbnail",
    "thumb",
    "w_",
    "h_",
    "width=",
    "height=",
    "size=",
  ];

  const kept = query.split("&").filter((parameter) => {
    const lowered = parameter.toLowerCase();
    return !resizeMarkers.some((marker) => lowered.includes(marker.toLowerCase()));
  });

  if (kept.length === query.split("&").length) return url;
  return kept.length > 0 ? `${base}?${kept.join("&")}` : base;
}

/**
 * Removes a thumbnail suffix from the file name.
 *
 * `poster_thumb.jpg` and `poster-small.jpg` are common conventions for the small render of
 * `poster.jpg`. Only a trailing marker immediately before the extension is removed, so a title
 * that genuinely contains "small" in the middle of its name is untouched.
 */
function stripThumbnailSuffix(url: string): string {
  const suffixes = [
    "_thumb",
    "-thumb",
    ".thumb",
    "_small",
    "-small",
    "_s",
    "-s",
    "_mini",
    "-mini",
    "_list",
    "-list",
  ];
  const [path, rest] = splitOnce(url, "?");
  const lastSlash = path.lastIndexOf("/");
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const file = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return url;

  const stem = file.slice(0, dot);
  const extension = file.slice(dot);
  const lowered = stem.toLowerCase();
  const match = suffixes.find((suffix) => lowered.endsWith(suffix));
  if (!match) return url;

  const trimmedStem = stem.slice(0, stem.length - match.length);
  // A suffix that is the entire name would leave nothing behind.
  if (!trimmedStem) return url;
  return `${directory}${trimmedStem}${extension}${rest ? `?${rest}` : ""}`;
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  if (index < 0) return [value, ""];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

export interface PosterResolution {
  url: string;
  width: number;
  height: number;
}

/**
 * Loads every candidate and keeps the one with the most pixels.
 *
 * Measured rather than assumed: a variant is only accepted if the browser actually decoded it and
 * it is genuinely larger. If nothing beats the original, or the runtime has no `Image`, the
 * original is returned unchanged — so this can only improve the result, never break it.
 *
 * Every candidate is requested in parallel. They are the same artwork, so the extra requests are
 * cache hits at worst, and doing them in sequence would make opening the viewer wait on each
 * failure in turn.
 */
export async function resolveLargestPoster(
  url: string,
  timeoutMs = 8000,
): Promise<PosterResolution> {
  const candidates = posterCandidates(url);
  if (candidates.length <= 1 || typeof Image === "undefined") {
    return { url, width: 0, height: 0 };
  }

  const measured = await Promise.all(
    candidates.map((candidate) => measure(candidate, timeoutMs)),
  );

  let best: PosterResolution | null = null;
  for (const result of measured) {
    if (!result) continue;
    const area = result.width * result.height;
    if (!best || area > best.width * best.height) best = result;
  }

  // Ties keep the earliest candidate, which is the highest-quality guess.
  return best ?? { url, width: 0, height: 0 };
}

function measure(url: string, timeoutMs: number): Promise<PosterResolution | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const requestId = isTauriRuntime() && !isEmbeddedImage(url) ? crypto.randomUUID() : null;
    let pendingRequest = requestId !== null;
    const finish = (value: PosterResolution | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (requestId && pendingRequest) void cancelMediaRequest(requestId).catch(() => undefined);
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    image.onload = () =>
      finish({ url, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => finish(null);
    if (requestId) {
      void fetchMediaResource(url, {}, undefined, requestId ?? undefined).then((resource) => {
        pendingRequest = false;
        if (settled) return;
        if (!resource) { finish(null); return; }
        image.src = imageDataUrl(resource.bodyBase64, resource.contentType);
      }).catch(() => finish(null));
    } else image.src = url;
  });
}
