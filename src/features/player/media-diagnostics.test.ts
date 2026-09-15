import { describe, expect, it } from "vitest";

import {
  extractUpstreamStatus,
  formatHlsError,
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
