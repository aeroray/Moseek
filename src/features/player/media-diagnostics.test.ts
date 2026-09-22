import { describe, expect, it } from "vitest";

import {
  describeMpegtsError,
  describePipeline,
  extractUpstreamStatus,
  formatHlsError,
  formatMpegtsError,
  mediaPipelineLabels,
} from "@/features/player/media-diagnostics";

describe("upstream status recovery", () => {
  it("reads the status out of a reqwest status error", () => {
    expect(
      extractUpstreamStatus(
        "媒体资源返回错误状态：HTTP status client error (403 Forbidden) for url (http://example.com/a.m3u8)",
      ),
    ).toBe(403);
    expect(
      extractUpstreamStatus(
        "HTTP status server error (503 Service Unavailable) for url (http://example.com/a.m3u8)",
      ),
    ).toBe(503);
  });

  it("reads a plain status mention and ignores unrelated numbers", () => {
    expect(extractUpstreamStatus("上游返回 HTTP 429")).toBe(429);
    expect(
      extractUpstreamStatus(
        "媒体资源请求失败：error sending request for url (http://39.134.24.166/x.m3u8)；connection closed before message completed",
      ),
    ).toBe(0);
    expect(extractUpstreamStatus(undefined)).toBe(0);
  });
});

describe("HLS failure messages", () => {
  it("names a region block, which has a different remedy from an operator lock", () => {
    // The upstream states the reason in the body: "The region has been denied". Reporting that as
    // "只对特定运营商网络开放" points the user at the wrong fix — the address is not
    // operator-restricted, it is refused for where the request came from.
    const message = formatHlsError(
      "manifestLoadError",
      403,
      "媒体资源返回错误状态：HTTP 403；403 Forbidden The region has been denied.",
    );
    expect(message).toContain("按地区拒绝");
    expect(message).toContain("地区");
    // The remedy is named, not just the cause.
    expect(message).toContain("允许的地区");
    expect(message).not.toContain("运营商网络");
  });

  it("still reports a plain rejection as an operator or credential lock", () => {
    // The distinction has to survive: a 403 with no region wording keeps the old explanation.
    const message = formatHlsError(
      "manifestLoadError",
      403,
      "媒体资源返回错误状态：HTTP 403",
    );
    expect(message).toContain("运营商网络");
    expect(message).not.toContain("按地区拒绝");
  });

  it("blames the upstream when it rejects the client", () => {
    const message = formatHlsError("manifestLoadError", 403);
    expect(message).toContain("上游拒绝访问");
    expect(message).toContain("HTTP 403");
  });

  it("still recognises a rejection when the loader only reported text", () => {
    const message = formatHlsError(
      "manifestLoadError",
      0,
      "媒体资源返回错误状态：HTTP status client error (403 Forbidden) for url (http://[2409:8087:8:21::18]:6610/a.m3u8?IASHttpSessionId=OTT2116)",
    );
    expect(message).toContain("上游拒绝访问");
    expect(message).toContain("HTTP 403");
  });

  it("recognises a peer that closes the connection before responding", () => {
    const message = formatHlsError(
      "manifestLoadError",
      0,
      "媒体资源请求失败：error sending request for url (http://183.207.248.71/gitv/live1/G_JSZY/G_JSZY)；client error (SendRequest)；connection closed before message completed",
    );
    expect(message).toContain("对端在返回任何响应前就关闭了连接");
  });

  it("reports a timeout as a timeout, not as a closed connection", () => {
    // `error sending request` is reqwest's generic prefix on every transport failure, so
    // matching it made this timeout read as "对端在返回任何响应前就关闭了连接" — blaming the peer
    // for our own deadline.
    const message = formatHlsError(
      "manifestLoadError",
      0,
      "媒体资源请求失败：error sending request for url (http://137.175.111.185/migu/?id=)；operation timed out",
    );
    expect(message).toContain("超时");
    expect(message).not.toContain("对端在返回任何响应前就关闭了连接");
  });

  it("does not treat every transport error as a closed connection", () => {
    // Only the generic prefix, nothing else: there is no specific cause to name.
    const message = formatHlsError(
      "manifestLoadError",
      0,
      "媒体资源请求失败：error sending request for url (http://example.com/a.m3u8)",
    );
    expect(message).not.toContain("对端在返回任何响应前就关闭了连接");
    expect(message).toContain("上游播放地址可能已失效或拒绝访问");
  });

  it("keeps a generic hint for unexplained manifest failures", () => {
    const message = formatHlsError("manifestLoadError", 0, undefined);
    expect(message).toContain("上游播放地址可能已失效或拒绝访问");
  });

  it("does not mention CORS, which the desktop runtime bypasses", () => {
    expect(formatHlsError("manifestLoadError", 0)).not.toContain("跨域");
  });

  it("distinguishes a non-playlist response from a network failure", () => {
    const message = formatHlsError("manifestLoadError", 415);
    expect(message).toContain("不是有效的 HLS 清单");
  });
});

describe("pipeline labels", () => {
  it("names the FLV pipeline as mpegts.js rather than as hls.js", () => {
    // The report has to be honest about which library ran. Reporting an FLV stream as an HLS
    // pipeline would point anyone reading the diagnosis at a component that never loaded.
    expect(mediaPipelineLabels["flv-mpegts"]).toContain("mpegts.js");
    expect(mediaPipelineLabels["flv-mpegts"]).not.toContain("hls.js");
  });
});

describe("pipeline media source reporting", () => {
  /** mpegts.js exposes no MediaSource accessor, so this is what the panel actually receives. */
  function videoWithSrc(src: string) {
    return {
      src,
      buffered: {
        length: 1,
        start: () => 0,
        end: () => 12.5,
      },
    } as unknown as HTMLVideoElement;
  }

  it("does not claim mpegts.js has no MediaSource when it is playing through one", () => {
    // mpegts.js keeps its MediaSource private, so `mediaSource` is always null for this pipeline.
    // Reporting "未挂载" beside 12.5s of buffered data would contradict itself and send a reader
    // looking for a mounting failure that never happened.
    const snapshot = describePipeline(
      null,
      "flv-mpegts",
      videoWithSrc("blob:http://tauri.localhost/abc"),
      null,
    );
    expect(snapshot.mediaSourceState).toBe("由 mpegts.js 托管");
    expect(snapshot.mediaSourceState).not.toBe("未挂载");
    expect(snapshot.bufferedSeconds).toBe(12.5);
  });

  it("still says so when the FLV pipeline never attached", () => {
    // The blob URL is the corroborating evidence: mpegts.js only ever plays through one.
    const snapshot = describePipeline(null, "flv-mpegts", videoWithSrc(""), null);
    expect(snapshot.mediaSourceState).toBe("未挂载");
  });

  it("keeps reporting the real readyState for the HLS pipeline", () => {
    const snapshot = describePipeline(
      null,
      "hls-inline",
      videoWithSrc("blob:http://tauri.localhost/abc"),
      { readyState: "open" } as unknown as MediaSource,
    );
    expect(snapshot.mediaSourceState).toBe("open");
  });
});

describe("FLV failure messages", () => {
  it("never blames an HLS manifest for an FLV stream", () => {
    // The whole reason this pipeline exists is that an FLV stream is not a playlist. Saying
    // "清单" here would describe a stage that never ran, which is the exact misdiagnosis being fixed.
    const messages = [
      formatMpegtsError("NetworkError", "NetworkException", { code: 0, msg: "socket closed" }),
      formatMpegtsError("NetworkError", "NetworkStatusCodeInvalid", { code: 403, msg: "Forbidden" }),
      formatMpegtsError("NetworkError", "NetworkUnrecoverableEarlyEof", { code: 0, msg: "eof" }),
      formatMpegtsError("MediaError", "MediaFormatError", { code: 0, msg: "invalid" }),
      formatMpegtsError("MediaError", "MediaCodecUnsupported", { code: 0, msg: "hvc1" }),
      formatMpegtsError("MediaError", "MediaMSEError", { code: 0, msg: "buffer" }),
      formatMpegtsError("OtherError", "Unknown", { code: 0, msg: "?" }),
    ];
    for (const message of messages) {
      expect(message).not.toContain("清单");
      expect(message).not.toContain("HLS");
    }
  });

  it("separates a timeout from a peer that stops sending", () => {
    // The same distinction the HLS copy makes, for the same reason: the remedies differ.
    const timedOut = formatMpegtsError("NetworkError", "NetworkException", {
      code: 0,
      msg: "operation timed out",
    });
    expect(timedOut).toContain("超时");

    const closed = formatMpegtsError("NetworkError", "NetworkException", {
      code: 0,
      msg: "connection closed before message completed",
    });
    expect(closed).toContain("无法从上游持续读取");
    expect(closed).not.toContain("超时");
  });

  it("keeps an upstream status visible", () => {
    const message = formatMpegtsError("NetworkError", "NetworkStatusCodeInvalid", {
      code: 403,
      msg: "Forbidden",
    });
    expect(message).toContain("HTTP 403");
  });

  it("still says something useful when mpegts.js supplies nothing", () => {
    // mpegts.js reports three separate arguments and any of them may be absent; a blank message
    // would leave the diagnostic timeline with an empty row.
    expect(describeMpegtsError()).toContain("未提供错误详情");
    expect(formatMpegtsError()).toContain("FLV 直播播放失败");
  });

  it("keeps the media type and detail in the timeline description", () => {
    // The type is what separates a dead upstream from an undecodable stream, so it has to survive.
    const described = describeMpegtsError("MediaError", "MediaCodecUnsupported", {
      code: 0,
      msg: "HEVC not supported",
    });
    expect(described).toContain("MediaError");
    expect(described).toContain("MediaCodecUnsupported");
    expect(described).toContain("HEVC not supported");
  });
});
