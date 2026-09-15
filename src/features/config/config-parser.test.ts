import { describe, expect, it } from "vitest";

import {
  countParsedCapabilities,
  formatConfigText,
  MAX_CONFIG_TEXT_BYTES,
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
    expect(result.configDialect).toBe("tvbox");
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

  it("normalizes Kitty arrays and preserves JS source metadata without executing it", () => {
    const result = parseConfigText(`[
      {
        id: "kitty-cms",
        name: "猫 CMS",
        type: 0,
        api: "https://cms.example/api",
        logo: "https://example.com/logo.png",
        desc: "测试源",
        nsfw: true
      },
      {
        id: "kitty-js",
        name: "猫 JS",
        type: 1,
        api: "https://example.com",
        extra: { js: { search: "getSearch" } },
        status: false
      }
    ]`);

    expect(result.ok).toBe(true);
    expect(result.configDialect).toBe("kitty");
    expect(result.sources[0]).toMatchObject({
      key: "kitty-cms",
      sourceDialect: "kitty",
      logo: "https://example.com/logo.png",
      description: "测试源",
      nsfw: true,
      enabled: true,
    });
    expect(result.sources[1]).toMatchObject({
      key: "kitty-js",
      sourceDialect: "kitty",
      siteProtocol: "js-extension",
      capability: "blocked",
      enabled: false,
      status: false,
    });
    expect(result.sources[1]?.extra).toContain('"js"');
    expect(result.normalizedConfig).toContain('"configDialect": "kitty"');
  });

  it("accepts the data alias and normalizes safe GET parse services", () => {
    const result = parseConfigText(`{
      data: [{ id: "data-source", name: "数据源", type: 0, api: "https://example.com/api" }],
      parses: [
        { id: "parse-1", name: "解析一", url: "https://parser.example/parse", headers: { Referer: "https://example.com" } },
        { id: "parse-2", name: "POST 解析", url: "https://parser.example/post", method: "POST", body: { token: "demo" } }
      ]
    }`);

    expect(result.ok).toBe(true);
    expect(result.configDialect).toBe("kitty");
    expect(result.sources[0]?.key).toBe("data-source");
    expect(result.parseServices).toMatchObject([
      {
        key: "parse-1",
        capability: "supported",
        method: "GET",
        headers: { Referer: "https://example.com" },
      },
      {
        key: "parse-2",
        capability: "supported",
        method: "POST",
        body: { token: "demo" },
      },
    ]);
    expect(result.normalizedConfig).toContain('"parses"');
  });

  it("resolves relative live URLs against a remote config URL", () => {
    const result = parseConfigText(
      `{
        lives: [
          { key: "live-2", name: "SA00", url: "./libs/tv/tvlive.txt" },
          { key: "live-3", name: "IPV6", url: "./lib/tv/ipv6.m3u" }
        ]
      }`,
      "https://config.example/repository/config.json",
    );

    expect(result.sources.map((source) => source.api)).toEqual([
      "https://config.example/repository/libs/tv/tvlive.txt",
      "https://config.example/repository/lib/tv/ipv6.m3u",
    ]);
    expect(
      result.sources.every((source) => source.capability === "supported"),
    ).toBe(true);
  });

  it("classifies declarative HTML mappings without enabling remote scripts", () => {
    const result = parseConfigText(`{
      sites: [
        {
          key: "html-source",
          name: "HTML 源",
          type: 5,
          api: "https://example.com/search",
          ext: {
            adapter: "html",
            itemSelector: ".item",
            fields: {
              id: { selector: "a", attr: "href" },
              name: { selector: ".title" }
            }
          }
        },
        { key: "html-incomplete", name: "缺字段", type: "html", api: "https://example.com" }
      ]
    }`);

    expect(result.sources[0]).toMatchObject({
      siteProtocol: "html-http",
      capability: "supported",
    });
    expect(result.sources[1]).toMatchObject({
      siteProtocol: "html-http",
      capability: "needs-adapter",
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

  it("treats blank text fields as missing instead of failing the whole config", () => {
    const result = parseConfigText(`{
      sites: [{
        key: "",
        name: "空字段源",
        api: "https://cms.example/api",
        ext: "",
        jar: "",
        epg: "",
      }],
      lives: [{
        key: "",
        name: "直播源",
        url: "https://live.example/channels.m3u",
        source: "",
        api: "",
        ext: "",
        epg: "",
      }],
    }`);

    expect(result.ok).toBe(true);
    expect(result.sources[0]?.capability).toBe("invalid");
    expect(result.sources[0]?.ext).toBeUndefined();
    expect(result.sources[0]?.jar).toBeUndefined();
    expect(result.sources[1]?.sourceType).toBe("live");
    expect(result.sources[1]?.api).toBe("https://live.example/channels.m3u");
  });

  it("makes duplicate source keys unique across CMS and live sources", () => {
    const result = parseConfigText(`{
      sites: [
        { key: "MV_vod", name: "明星 MV", api: "https://one.example/api" },
        { key: "MV_vod", name: "明星 MV 备用", api: "https://two.example/api" },
      ],
      lives: [{ key: "MV_vod", name: "MV 直播", url: "https://live.example/m3u" }],
    }`);

    expect(result.ok).toBe(true);
    expect(result.sources.map((source) => source.key)).toEqual([
      "MV_vod",
      "MV_vod-2",
      "MV_vod-3",
    ]);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "sites.1",
      "lives.0",
    ]);
    expect(result.normalizedConfig).toContain('"key": "MV_vod-2"');
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

  it("rejects oversized config text before parsing or formatting", () => {
    const oversized = " ".repeat(MAX_CONFIG_TEXT_BYTES + 1);

    expect(parseConfigText(oversized).issues[0]?.message).toContain("10 MiB");
    expect(formatConfigText(oversized).issue?.message).toContain("10 MiB");
    expect(repairConfigText(oversized).issue?.message).toContain("10 MiB");
  });
});
