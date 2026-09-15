import { describe, expect, it } from "vitest";

import { getByteRangeHeader } from "@/features/player/media-range";
import { usesHlsPipeline } from "@/features/player/media-player";

describe("HLS byte-range requests", () => {
  it("does not send a range for ordinary fragments", () => {
    expect(getByteRangeHeader(0, 0)).toBeUndefined();
    expect(getByteRangeHeader()).toBeUndefined();
  });

  it("converts the exclusive end offset to an HTTP range", () => {
    expect(getByteRangeHeader(1024, 2048)).toBe("bytes=1024-2047");
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
