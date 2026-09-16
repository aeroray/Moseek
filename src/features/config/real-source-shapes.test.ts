import { describe, expect, it } from "vitest";

import { parseConfigText } from "@/features/config/config-parser";

// A compact slice of the user's real imported config, used to confirm the XBPQ classification
// reaches the shapes actually present in it. Real `key`/`api`/`ext` triples, copied verbatim.
const REAL_SITES = [
  // XBPQ, ext is a URL to the declarative config, plus a JAR for the TVBox runtime.
  {
    key: "fok",
    name: "🌙┃夸克┃影视",
    type: 3,
    api: "csp_XBPQ",
    ext: "http://rihou.vip:88/hccx/七新影视.json",
    jar: "https://jihulab.com/xiaohutx/meisha/-/raw/main/1.jar;md5;bb155c3f0133bbce4756ad52003f5968",
  },
  // XBPQ with the config inline as JSON.
  {
    key: "csp_nkvlog",
    name: "夸克",
    type: 3,
    api: "csp_XBPQ",
    ext: JSON.stringify({
      分类url: "https://www.freeok.vip/vod-show/{cateId}-{area}-------{catePg}---{year}.html",
      分类: "FREE电影&FREE剧集&FREE动漫&FREE综艺&FREE短剧&FREE少儿",
      分类值: "1&2&3&4&12&5",
      数组: 'class="stui-vodlist__box&&</li',
    }),
    jar: "https://example.com/a.jar",
  },
  // XYQHiker, ext is a URL.
  {
    key: "奈飞中文",
    name: "🎗┃奈飞┃秒播",
    type: 3,
    api: "csp_XYQHiker",
    ext: "http://qrh.yimkj.cn/ym/lib/nfzw.json",
    jar: "http://qrh.yimkj.cn/ym/lib/ttkx.jar",
  },
  // drpy: api points at the engine, ext at a per-site script. Must stay blocked.
  {
    key: "drpy_js_豆瓣",
    name: "🔥聚玩盒子4K",
    type: 3,
    api: "https://jihulab.com/yydfys/yydf/-/raw/main/yydf/lib/drpy2.min.js",
    ext: "https://jihulab.com/yydfys/yydf/-/raw/main/yydf/lib/douban.js",
  },
  // AppMao: encrypted payload. Must stay blocked.
  {
    key: "南坊",
    name: "🎃┃南坊┃App",
    type: 3,
    api: "csp_AppMao",
    ext: "FbjDcUxPqpfNr0QF4QvE6sExbd4UXJxJXzdL462ywU1XScGa5G6Hj0/c+Ou1GW6rdX6N2XIhnD46QzIsRoZ8bk4fG4OYi0iCaWwRj2ddkaI+FqHtLjQhalHqIy0+kpiTv2eOfJYxTshgoxEZvRX9BA0UIrOurFxHa4dPZw==",
    jar: "https://example.com/appmao.jar",
  },
];

function find(result: ReturnType<typeof parseConfigText>, key: string) {
  const source = result.sources.find((s) => s.key === key);
  if (!source) throw new Error(`source ${key} missing`);
  return source;
}

describe("the real configuration's source shapes", () => {
  const result = parseConfigText(JSON.stringify({ sites: REAL_SITES }));

  it("supports the XBPQ sources that carry a config URL and a JAR", () => {
    const source = find(result, "fok");

    expect(source.capability).toBe("supported");
    expect(source.siteProtocol).toBe("xbpq");
    expect(source.enabled).toBe(true);
  });

  it("supports the XBPQ sources whose config is inline JSON", () => {
    const source = find(result, "csp_nkvlog");

    expect(source.capability).toBe("supported");
    expect(source.siteProtocol).toBe("xbpq");
  });

  it("supports the XYQHiker sources", () => {
    const source = find(result, "奈飞中文");

    expect(source.capability).toBe("supported");
    expect(source.siteProtocol).toBe("xbpq");
  });

  it("keeps drpy blocked, because it needs a downloaded script", () => {
    // `ext` is a per-site .js the engine executes. Nothing declarative to read.
    const source = find(result, "drpy_js_豆瓣");

    expect(source.capability).toBe("blocked");
    expect(source.enabled).toBe(false);
  });

  it("keeps AppMao blocked, because its payload is encrypted", () => {
    const source = find(result, "南坊");

    expect(source.capability).toBe("blocked");
  });
});
