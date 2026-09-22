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

  it("accepts the string spellings of a boolean flag that real files contain", () => {
    // TVBox writes these keys five ways, and the schema used to reject two of them. A single
    // `"searchable": "true"` then failed validation for the ENTIRE document, which is why the user's
    // save reported "Invalid input: expected boolean, received string" and named nothing they could
    // act on. A file in the wild is not ours to reject.
    const result = parseConfigText(`{
      sites: [{
        key: "string-flags",
        name: "字符串开关",
        api: "https://cms.example/api",
        searchable: "true",
        quickSearch: "false",
        filterable: "1",
      }],
      lives: [{ key: "l", name: "直播", url: "https://live.example/tv.txt", status: "true" }],
    }`);

    expect(result.ok).toBe(true);
    expect(result.sources.find((source) => source.key === "string-flags")?.searchable).toBe(true);
    expect(result.sources.find((source) => source.key === "string-flags")?.filterable).toBe(true);
    expect(result.sources.find((source) => source.key === "l")?.enabled).toBe(true);
  });

  it("still rejects a flag value that is neither a boolean nor a number", () => {
    // Accepting the real spellings must not mean accepting anything: a genuine mistake still has to
    // be reported, or the schema stops being a check at all.
    const result = parseConfigText(`{
      sites: [{ key: "bad", name: "坏", api: "https://cms.example/api", searchable: "yes" }],
    }`);

    expect(result.ok).toBe(false);
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

  it("repairs a string flag into a real boolean, and says what it changed", () => {
    // Two fixes meet here, and they are different things.
    //
    // The schema now ACCEPTS the string spellings, which is what unblocked saving — so a document
    // like this one can be saved as it stands. What the repair adds is normalisation: the file is
    // rewritten with real booleans, which is what the format means and what other TVBox clients
    // expect. The user's report was that 自动修正 reported "未发现可自动修正的问题" over text that
    // plainly had something wrong with it; a repair that cannot see a type problem at all is the
    // behaviour that had to change.
    const text = JSON.stringify({
      sites: [
        { key: "a", name: "甲", api: "https://a.example/api", searchable: "true" },
        { key: "b", name: "乙", api: "https://b.example/api", filterable: "false" },
      ],
    });

    // It is already saveable, because the schema accepts the spelling.
    expect(parseConfigText(text).ok).toBe(true);

    const repaired = repairConfigText(text);
    expect(repaired.ok).toBe(true);
    expect(repaired.changes.join("")).toContain("开关");

    const after = JSON.parse(repaired.text) as {
      sites: { searchable?: unknown; filterable?: unknown }[];
    };
    expect(after.sites[0].searchable).toBe(true);
    expect(after.sites[1].filterable).toBe(false);
    expect(parseConfigText(repaired.text).ok).toBe(true);
  });

  it("leaves a flag value it does not understand exactly as it was", () => {
    // A repair that rewrites fields it does not recognise can turn a working configuration into a
    // different one. Only the spellings a real file uses are coerced.
    const text = JSON.stringify({
      sites: [{ key: "a", name: "甲", api: "https://a.example/api", searchable: "maybe" }],
    });

    const repaired = repairConfigText(text);
    expect(repaired.ok).toBe(true);
    const after = JSON.parse(repaired.text) as { sites: { searchable?: unknown }[] };
    expect(after.sites[0].searchable).toBe("maybe");
    // Still rejected, so the user is still told — coercion did not paper over it.
    expect(parseConfigText(repaired.text).ok).toBe(false);
  });

  it("repairs a field name that lost its opening quote", () => {
    // Measured on 肥猫's published file: exactly two keys read `ext": {` instead of `"ext": {`, and
    // quoting them makes the whole document parse into 39 sites and 2 lives. Without the repair the
    // user loses the entire configuration to a publisher's typo, and the error they see —
    // `invalid character '"' at 125:4` — points at the symptom rather than the cause.
    const text = `{
  "sites": [
    {
      "key": "甲",
      "name": "甲源",
      "api": "https://a.example/api",
ext": {
        "host": ""
      }
    }
  ]
}`;

    expect(parseConfigText(text).ok).toBe(false);

    const repaired = repairConfigText(text);
    expect(repaired.ok).toBe(true);
    expect(repaired.changes.join("")).toContain("缺少左引号");
    expect(parseConfigText(repaired.text).ok).toBe(true);
    // The value is preserved, not just the syntax.
    const after = JSON.parse(repaired.text) as { sites: { ext?: { host?: string } }[] };
    expect(after.sites[0].ext?.host).toBe("");
  });

  it("repairs EVERY malformed field name, not just the first", () => {
    // The order of the repair passes is load-bearing, and getting it wrong produced exactly this
    // failure: the newline-escaping pass ran first and rewrote the malformed line, so only one of the
    // two keys still matched and the document stayed unparseable with a NEW error at a new line.
    // That is the "I pressed the fix button and it did not fix it" the user reported about 自动修正.
    //
    // Two malformed keys is the real shape, so two is what this pins.
    const text = `{
  "sites": [
    {
      "key": "甲",
      "name": "甲源",
      "api": "https://a.example/api",
ext": {
        "host": ""
      }
    },
    {
      "key": "乙",
      "name": "乙源",
      "api": "https://b.example/api",
ext": {
        "host": ""
      }
    }
  ]
}`;

    const repaired = repairConfigText(text);
    expect(repaired.ok).toBe(true);
    expect(repaired.changes.join("")).toContain("2 处");
    const after = JSON.parse(repaired.text) as { sites: { ext?: unknown }[] };
    expect(after.sites).toHaveLength(2);
    expect(after.sites[0].ext).toBeDefined();
    expect(after.sites[1].ext).toBeDefined();
  });

  it("leaves a correctly quoted document alone", () => {
    // The quote repair is narrow on purpose: a bare identifier at the start of a line followed by `":`
    // cannot occur in valid JSON, so a document that was already correct must come through untouched.
    const text = JSON.stringify({
      sites: [{ key: "a", name: "甲", api: "https://a.example/api", ext: { host: "" } }],
    });
    const repaired = repairConfigText(text);
    expect(repaired.ok).toBe(true);
    expect(repaired.changes.join("")).not.toContain("缺少左引号");
    expect(JSON.parse(repaired.text)).toEqual(JSON.parse(text));
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

  it("accepts an object ext on a live source", () => {
    // Live `ext` is an object in the wild (`{"sp":"Huya"}`). Treating it as plain text made
    // one such entry fail validation for the entire configuration, with an error that did
    // not name the field.
    const result = parseConfigText(`{
      lives: [
        { name: "虎牙", url: "https://live.example/huya.m3u8", ext: { sp: "Huya" } },
      ],
    }`);

    expect(result.ok).toBe(true);
    expect(result.liveCount).toBe(1);
    expect(result.sources[0]?.ext).toBe('{"sp":"Huya"}');
  });

  it("names the offending field when a schema check fails", () => {
    const result = parseConfigText(`{
      lives: [{ name: { nested: true }, url: "https://live.example/a.m3u8" }],
    }`);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.path).toBe("lives.0.name");
    expect(result.issues[0]?.line).toBeNull();
  });
});
