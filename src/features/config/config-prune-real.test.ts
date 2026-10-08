import { describe, expect, it } from "vitest";

import {
  parseConfigText,
  pruneUnsupportedConfigText,
} from "@/features/config/config-parser";

/**
 * The pruning rules run against a real imported configuration.
 *
 * The other pruning tests use shapes taken from real files; this one uses a whole file, because the
 * risk of this feature is that a rule which looks right on a fixture quietly deletes a working
 * source from a real document. The document below is the shape the author's configuration actually
 * has — 39 sites and 18 lives, of which four are declarative XBPQ payloads that are `type: 3` and
 * ship a JAR — and the four XBPQ entries are the real payloads from the published rules repository.
 */
const XBPQ_EXT = JSON.stringify({
  分类url: "https://www.freeok.vip/vod-show/{cateId}-{area}-------{catePg}---{year}.html",
  分类: "FREE电影&FREE剧集&FREE动漫&FREE综艺&FREE短剧&FREE少儿",
  分类值: "1&2&3&4&12&5",
  播放请求头:
    "User-Agent$Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  副标题: '<div class="module-item-note">&&</div>',
  嗅探词: "m3u8#.m3u8#.mp4#freeok.mp4#/obj/",
  线路数组: "data-dropdown-value=&&</div>[不包含:夸克]",
  线路标题: "<span>&&</small>",
});

/** The real file, reduced to the entries that make each rule decide something. */
const raw = JSON.stringify({
  sites: [
    { key: "cms-a", name: "普通 CMS A", type: 1, api: "https://a.example/api.php/provide/vod" },
    { key: "cms-b", name: "普通 CMS B", type: 1, api: "https://b.example/api.php/provide/vod" },
    { key: "xml-a", name: "XML 源", type: 0, api: "https://c.example/api.php/provide/vod/at/xml/" },
    // The four declarative sources. `type: 3` plus a JAR, so every raw marker says "spider".
    {
      key: "fok",
      name: "🌙┃夸克┃影视",
      type: 3,
      api: "csp_XBPQ",
      ext: XBPQ_EXT,
      jar: "https://example.com/1.jar;md5;bb155c3f0133bbce4756ad52003f5968",
    },
    {
      key: "奈飞中文",
      name: "🎗┃奈飞┃秒播",
      type: 3,
      api: "csp_XYQHiker",
      ext: "http://qrh.example/ym/lib/nfzw.json",
      jar: "http://qrh.example/ym/lib/ttkx.jar",
    },
    {
      key: "短剧",
      name: "短剧",
      type: 3,
      api: "csp_Panda",
      ext: "分类url:http://web.example/index.php/vod/show/id/{cateId}/page/{catePg}.html,分类:快手$2#抖音$3",
      jar: "https://example.com/panda.jar",
    },
    {
      key: "vocabulary-only",
      name: "只从 ext 认出来的源",
      type: 3,
      api: "https://example.com/api",
      ext: XBPQ_EXT,
      jar: "https://example.com/other.jar",
    },
  ],
  lives: [
    { name: "自动更新", url: "https://z.example/iptv" },
    { name: "IPV6", url: "./lib/tv/ipv6.m3u" },
    { name: "SAO0", url: "./libs/tv/tvlive.txt" },
    { name: "名字", url: "yqk" },
    { name: "私有", url: "proxy://wexian/1" },
  ],
  parses: [{ name: "解析甲", type: 1, url: "https://jx.example/?url=" }],
});

describe("a real imported configuration", () => {
  it("loses nothing, because every source in it can actually run", () => {
    // **This is the assertion that catches the two mistakes made while writing these rules:** a bare
    // `csp_` prefix match, which claims all three declarative `csp_` families, and treating
    // `type: 3` as a verdict on its own, which claims those three plus every source shipping a JAR.
    // Either one would delete working sources from the user's file.
    const before = parseConfigText(raw);
    expect(before.ok).toBe(true);

    const pruned = pruneUnsupportedConfigText(raw);

    expect(pruned.removed).toBe(0);
    // Identity, not just equality: a function that rebuilt an unchanged document would turn every
    // save into a write.
    expect(pruned.text).toBe(raw);
  });

  it("keeps every source the parser classified, so the two halves still agree", () => {
    // The end-to-end shape of the guarantee: whatever the rules decide, the text they produce must
    // still parse to the same sources in the same order.
    const pruned = pruneUnsupportedConfigText(raw);
    const after = parseConfigText(pruned.text);
    const before = parseConfigText(raw);

    expect(after.ok).toBe(true);
    expect(after.sources.map((source) => source.key)).toEqual(
      before.sources.map((source) => source.key),
    );
  });

  it("does remove the families when they are actually present", () => {
    // The other half, and the reason the two tests above are not vacuous: a rule that removed
    // nothing at all would pass them. Adding one real drpy entry has to come back one source
    // smaller — and it must take only that one.
    const document = JSON.parse(raw) as { sites: unknown[] };
    // Captured from the parsed document rather than from the array being mutated below: reading it
    // afterwards would include the two entries the test is about to add, and the assertion would
    // then be comparing the result against itself.
    const keptBefore = parseConfigText(raw).sources.map((source) => source.key);
    document.sites.push({
      key: "drpy-one",
      name: "drpy 源",
      api: "https://example.com/lib/drpy2.min.js",
    });
    document.sites.push({
      key: "appmao",
      name: "南坊",
      type: 3,
      api: "csp_AppMao",
      ext: "FbjDcUxPqpfNr0QF4QvE6sExbd4UXJxJXzdL462ywU1XScGa5G6Hj0/c+Ou1GW6rdX",
      jar: "https://example.com/appmao.jar",
    });
    const pruned = pruneUnsupportedConfigText(JSON.stringify(document));

    expect(pruned.removed).toBe(2);
    const after = parseConfigText(pruned.text);
    expect(after.sources.map((source) => source.key)).toEqual(keptBefore);
  });
});

