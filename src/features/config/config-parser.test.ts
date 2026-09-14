import { describe, expect, it } from "vitest";

import {
  countParsedCapabilities,
  formatConfigText,
  parseConfigText,
  repairConfigText,
} from "@/features/config/config-parser";

describe("Moseek config parser", () => {
  it("normalizes ordinary CMS sources and preserves live counts", () => {
    const result = parseConfigText(`{
      // JSON5 comments are accepted
      sites: [
        { key: "clzy", name: "初恋资源", type: 1, api: "https://cms.example/api" },
        { key: "xiaohu", name: "小胡", type: 3, api: "https://cms.example/xiaohu", jar: "https://cdn.example/xiaohu.jar" }
      ],
      lives: [{ name: "新闻", url: "https://live.example/news.m3u8", epg: "https://live.example/guide.xml" }],
    }`);

    expect(result.ok).toBe(true);
    expect(result.sources).toHaveLength(3);
    expect(result.sources[0]?.capability).toBe("supported");
    expect(result.sources[0]?.siteType).toBe(1);
    expect(result.sources[0]?.siteProtocol).toBe("json-http");
    expect(result.sources[0]?.testStatus).toBe("untested");
    expect(result.sources[1]?.capability).toBe("blocked");
    expect(result.sources[1]?.sourceType).toBe("cms");
    expect(result.sources[1]?.siteProtocol).toBe("spider");
    expect(result.sources[2]?.sourceType).toBe("live");
    expect(result.sources[2]?.epg).toBe("https://live.example/guide.xml");
    expect(result.sources[2]?.testStatus).toBe("untested");
    expect(result.normalizedConfig).toContain('"adapterId": "builtin-cms"');
    expect(result.normalizedConfig).toContain('"adapterId": "builtin-live"');
    expect(result.liveCount).toBe(1);
    expect(countParsedCapabilities(result.sources)).toMatchObject({
      supported: 2,
      blocked: 1,
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

  it("accepts numeric TVBox boolean flags and normalizes them", () => {
    const result = parseConfigText(`{
      sites: [{
        key: "numeric-flags",
        name: "数字开关",
        api: "https://cms.example/api",
        ext: { headers: { "User-Agent": "Moseek" } },
        searchable: 0,
        quickSearch: 1,
        filterable: "0",
      }],
    }`);

    expect(result.ok).toBe(true);
    expect(result.sources[0]?.searchable).toBe(false);
    expect(result.sources[0]?.filterable).toBe(false);
    expect(result.sources[0]?.ext).toContain('"headers"');
  });

  it("routes XML and HTTP extension site types without relabeling them as parsers", () => {
    const result = parseConfigText(`{
      sites: [
        { key: "xml-site", name: "XML", type: 0, api: "https://example.com/xml" },
        { key: "extension-site", name: "扩展", type: 4, api: "https://example.com/ext" },
        { key: "spider-site", name: "Spider", type: 3, api: "./demo.js" }
      ]
    }`);

    expect(result.sources.map((source) => source.siteProtocol)).toEqual([
      "xml-http",
      "http-extension",
      "spider",
    ]);
    expect(result.sources.map((source) => source.sourceType)).toEqual([
      "cms",
      "cms",
      "cms",
    ]);
    expect(result.sources[2]?.capability).toBe("blocked");
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

  it("formats valid JSON5 and repairs unescaped string newlines", () => {
    const formatted = formatConfigText("{sites: [], lives: [],}");
    const repaired = repairConfigText(
      '{"sites": [{"name": "line\nbreak", "api": "https://example.com"}]}',
    );

    expect(formatted.ok).toBe(true);
    expect(formatted.text).toContain('"sites": []');
    expect(parseConfigText(formatted.text).ok).toBe(true);
    expect(repaired.ok).toBe(true);
    expect(repaired.changes).toContain("转义字符串中的换行");
    expect(parseConfigText(repaired.text).ok).toBe(true);
  });

  it("does not rewrite text when repair cannot validate it", () => {
    const malformed = '{"sites": [{"name": "missing}]}';
    const repaired = repairConfigText(malformed);

    expect(repaired.ok).toBe(false);
    expect(repaired.text).toBe(malformed);
    expect(repaired.issue?.line).not.toBeNull();
  });
});
