import { describe, expect, it } from "vitest";

import { countParsedCapabilities, parseConfigText } from "@/features/config/config-parser";

describe("Moseek config parser", () => {
  it("normalizes ordinary CMS sources and preserves live counts", () => {
    const result = parseConfigText(`{
      // JSON5 comments are accepted
      sites: [
        { key: "clzy", name: "初恋资源", type: 1, api: "https://cms.example/api" },
        { key: "xiaohu", name: "小胡", type: 3, api: "https://cms.example/xiaohu", jar: "https://cdn.example/xiaohu.jar" }
      ],
      lives: [{ name: "新闻", url: "https://live.example/news.m3u8" }],
    }`);

    expect(result.ok).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]?.capability).toBe("supported");
    expect(result.sources[1]?.capability).toBe("partial");
    expect(result.liveCount).toBe(1);
    expect(countParsedCapabilities(result.sources)).toMatchObject({
      supported: 1,
      partial: 1,
    });
  });

  it("blocks remote scripts and marks private protocols for adapters", () => {
    const result = parseConfigText(`{
      spider: "https://example.com/remote.jar",
      sites: [
        { key: "csp_AppMao", name: "脚本源", api: "https://example.com/api" },
        { key: "proxy-source", name: "私有解析", api: "proxy://example.com/parse" },
        { key: "bad-source", name: "危险地址", api: "javascript:alert(1)" }
      ]
    }`);

    expect(result.ok).toBe(true);
    expect(result.sources.map((source) => source.capability)).toEqual([
      "blocked",
      "needs-adapter",
      "blocked",
    ]);
    expect(result.issues.some((issue) => issue.path === "spider")).toBe(true);
  });

  it("keeps invalid source rows visible while reporting missing fields", () => {
    const result = parseConfigText(`{ sites: [{ name: "缺少 API" }] }`);

    expect(result.ok).toBe(true);
    expect(result.sources[0]?.capability).toBe("invalid");
    expect(result.issues[0]?.path).toBe("sites.0");
  });

  it("returns line-aware parse errors and schema errors", () => {
    const malformed = parseConfigText(`{
      sites: [
    }`);
    const wrongShape = parseConfigText("{ sites: 'not-an-array' }");

    expect(malformed.ok).toBe(false);
    expect(malformed.issues[0]?.severity).toBe("error");
    expect(wrongShape.ok).toBe(false);
    expect(wrongShape.issues[0]?.path).toBe("sites");
  });
});
