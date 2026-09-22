import { describe, expect, it } from "vitest";

import {
  getByteRangeHeader,
  isEmptyFragmentResponse,
} from "@/features/player/media-range";
import { usesHlsPipeline } from "@/features/player/media-player";
import {
  resolveMediaPipeline,
  shouldProbeContainer,
} from "@/features/player/media-pipeline";

describe("HLS byte-range requests", () => {
  it("does not send a range for ordinary fragments", () => {
    expect(getByteRangeHeader(0, 0)).toBeUndefined();
    expect(getByteRangeHeader()).toBeUndefined();
  });

  it("converts the exclusive end offset to an HTTP range", () => {
    expect(getByteRangeHeader(1024, 2048)).toBe("bytes=1024-2047");
  });
});

describe("empty fragment responses", () => {
  it("treats a zero-byte media fragment as a failure", () => {
    // Observed from a real IPTV endpoint: `200 OK` with `Content-Length: 0` for every fragment
    // once the stream behind it went stale. Passing that to hls.js produced the misleading
    // "Failed to find demuxer by probing fragment data", blaming the content for what was
    // really a missing response body.
    expect(isEmptyFragmentResponse("arraybuffer", 0)).toBe(true);
  });

  it("accepts a fragment that carries data", () => {
    expect(isEmptyFragmentResponse("arraybuffer", 188)).toBe(false);
  });

  it("does not apply to playlist responses", () => {
    // An empty playlist is caught by the manifest check, which reports the more precise
    // "not a valid HLS playlist"; this check must not shadow it.
    expect(isEmptyFragmentResponse(undefined, 0)).toBe(false);
    expect(isEmptyFragmentResponse("text", 0)).toBe(false);
  });
});

describe("pipeline selection", () => {
  it("plays an explicit mp4 through the native element even on a live channel", () => {
    // A live channel normally means HLS, but one such channel pointed at a 51 MB mp4 behind a
    // redirecting endpoint. hls.js downloaded it as a manifest and failed on the size limit
    // instead of playing it.
    expect(
      usesHlsPipeline(
        "mp4",
        true,
        "https://cloud.video.taobao.com//play/u/1/p/1/e/6/t/1/313341682455.mp4",
      ),
    ).toBe(false);
  });

  it("keeps using hls.js for a live channel without a recognisable extension", () => {
    expect(usesHlsPipeline("unknown", true, "http://example.com/gitv/live1/G_JSZY/G_JSZY")).toBe(
      true,
    );
  });

  it("uses hls.js for an m3u8 and the native element for a vod mp4", () => {
    expect(usesHlsPipeline("hls", false, "https://example.com/a.m3u8")).toBe(true);
    expect(usesHlsPipeline("mp4", false, "https://example.com/a.mp4")).toBe(false);
  });

  it("still recognises an m3u8 url reported as unknown", () => {
    expect(usesHlsPipeline("unknown", false, "https://example.com/live/stream.m3u8")).toBe(true);
  });
});

describe("FLV pipeline selection", () => {
  it("routes an explicit .flv address to mpegts.js", () => {
    // hls.js cannot play FLV: it parses the response as an HLS playlist, so the failure it reports
    // ("manifestLoadError / error decoding response body") names a stage that never applied.
    expect(
      resolveMediaPipeline("unknown", true, "http://cdn.example/live/stream.flv"),
    ).toBe("flv");
    expect(usesHlsPipeline("unknown", true, "http://cdn.example/live/stream.flv")).toBe(false);
  });

  it("recognises .flv when the query string carries other extensions", () => {
    // Several CDNs put the real name in a parameter, and matching the whole string would also
    // accept a URL whose query merely mentions `.flv` while its path is something else.
    expect(
      resolveMediaPipeline("unknown", true, "http://cdn.example/live/a.flv?token=b.m3u8"),
    ).toBe("flv");
    expect(
      resolveMediaPipeline("unknown", true, "http://cdn.example/live/a.m3u8?name=b.flv"),
    ).toBe("hls");
  });

  it("keeps a live address with no extension on hls.js until it is measured", () => {
    // This is the ambiguous case, and the honest default: most extension-less live addresses really
    // are HLS, so the URL alone must not decide FLV.
    expect(
      resolveMediaPipeline("unknown", true, "https://live.ottiptv.cc/douyu/431460"),
    ).toBe("hls");
  });

  it("switches to mpegts.js when the measured container is FLV", () => {
    // The real failing channel: the requested address names no extension and only becomes an FLV
    // after a 301 redirect, so nothing about the requested URL could have predicted it.
    expect(
      resolveMediaPipeline("unknown", true, "https://live.ottiptv.cc/douyu/431460", {
        container: "flv",
        url: "http://huosa.douyucdn2.cn/live/431460rrhSOIDkva_550.flv?token=abc",
      }),
    ).toBe("flv");
  });

  it("uses the final url when it disagrees with the requested one", () => {
    // Evidence of the redirect is itself decisive even when the container verdict is unknown.
    expect(
      resolveMediaPipeline("unknown", true, "https://live.example/opaque", {
        container: "unknown",
        url: "http://cdn.example/live/stream.flv",
      }),
    ).toBe("flv");
    // ...and the converse must not hold: an m3u8 final url keeps hls.js.
    expect(
      resolveMediaPipeline("unknown", true, "https://live.example/opaque", {
        container: "hls",
        url: "https://cdn.example/live/stream.m3u8",
      }),
    ).toBe("hls");
  });

  it("lets measured bytes outrank an mp4 extension in both directions", () => {
    // The existing rule is that an explicit mp4 is never pushed through a transmuxer, because a
    // live mp4 behind hls.js downloaded whole and then failed on the size limit. That rule is about
    // a *label*; measured bytes are not a label, so they win: an address named `.mp4` that actually
    // serves FLV cannot be played by the native element at all, and mpegts.js is the only pipeline
    // that can demux it.
    expect(
      resolveMediaPipeline("mp4", false, "https://cdn.example/a.mp4", {
        container: "flv",
        url: "https://cdn.example/a.mp4",
      }),
    ).toBe("flv");
    // The converse: evidence that contradicts the label but names no pipeline we can use leaves the
    // native element in charge, which is what `usesHlsPipeline` already guaranteed for mp4.
    expect(
      resolveMediaPipeline("mp4", false, "https://cdn.example/a.mp4", {
        container: "hls",
        url: "https://cdn.example/a.mp4",
      }),
    ).toBe("native");
  });

  it("does not switch pipelines for a landing page", () => {
    // Several IPTV addresses answer 200 with a web page. hls.js already reports "not a valid HLS
    // playlist" for that, which is more accurate than anything this function could substitute.
    expect(
      resolveMediaPipeline("unknown", true, "https://live.example/opaque", {
        container: "html",
        url: "https://live.example/landing",
      }),
    ).toBe("hls");
  });
});

describe("container probing", () => {
  it("probes only the ambiguous live address", () => {
    // A round trip is only worth paying where the URL genuinely cannot answer.
    expect(shouldProbeContainer("unknown", true, "https://live.ottiptv.cc/douyu/431460")).toBe(true);
    expect(shouldProbeContainer("unknown", true, "http://cdn.example/a.flv")).toBe(false);
    expect(shouldProbeContainer("hls", true, "https://cdn.example/a.m3u8")).toBe(false);
    expect(shouldProbeContainer("mp4", true, "https://cdn.example/a.mp4")).toBe(false);
    // A VOD address is handled natively and must not gain a round trip.
    expect(shouldProbeContainer("unknown", false, "https://cdn.example/opaque")).toBe(false);
  });
});
