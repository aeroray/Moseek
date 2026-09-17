export function getByteRangeHeader(rangeStart?: number, rangeEnd?: number) {
  const start = rangeStart ?? 0;
  if (rangeEnd === undefined || rangeEnd <= start) return undefined;
  return `bytes=${start}-${rangeEnd - 1}`;
}

/**
 * Whether a media fragment response should be treated as a failure.
 *
 * Some IPTV endpoints answer a fragment request with `200 OK` and `Content-Length: 0` once the
 * stream behind them has gone stale. Reporting that as a successful load hands hls.js zero bytes
 * to demux, so it fails with "Failed to find demuxer by probing fragment data" — an error that
 * blames the content when the real problem is that nothing was sent. Catching it at the loader
 * names the actual cause.
 *
 * Only media fragments are checked. An empty playlist response is already rejected by the
 * `isHlsPlaylist` check, which is a more precise message for that case.
 */
export function isEmptyFragmentResponse(
  responseType: string | undefined,
  byteLength: number,
) {
  return responseType === "arraybuffer" && byteLength === 0;
}
