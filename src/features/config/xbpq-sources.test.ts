import { describe, expect, it } from "vitest";

import { parseConfigText } from "@/features/config/config-parser";

// Real payloads taken from an imported TVBox configuration. These sources are `type: 3` with a
// JAR, so they used to be recorded as blocked spiders; the configuration they carry is a
// vocabulary of URL templates and text markers, which is what makes them supportable.
const FREE_OK_EXT = JSON.stringify({
  分类url:
    "https://www.freeok.vip/vod-show/{cateId}-{area}-------{catePg}---{year}.html",
  分类: "FREE电影&FREE剧集&FREE动漫&FREE综艺&FREE短剧&FREE少儿",
  分类值: "1&2&3&4&12&5",
  播放请求头:
    "User-Agent$Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  副标题: '<div class="module-item-note">&&</div>',
  嗅探词: "m3u8#.m3u8#.mp4#freeok.mp4#/obj/",
  线路数组: "data-dropdown-value=&&</div>[不包含:夸克]",
  线路标题: "<span>&&</small>",
  导演: "导演：&&</div>",
  主演: "主演：&&</div>",
  简介: "<p>&&</p>",
});

function parse(sites: unknown[]) {
  return parseConfigText(JSON.stringify({ sites }));
}

function findSource(result: ReturnType<typeof parse>, key: string) {
  const source = result.sources.find((candidate) => candidate.key === key);
  if (!source) throw new Error(`source ${key} not found`);
  return source;
}

describe("XBPQ / XYQHiker sources", () => {
  it("treats a type-3 source with a declarative ext as supported", () => {
    // The JAR must not decide this: it is present on every real source of this family and is
    // never downloaded or executed.
    const result = parse([
      {
        key: "fok",
        name: "🌙┃夸克┃影视",
        type: 3,
        api: "csp_XBPQ",
        ext: FREE_OK_EXT,
        jar: "https://example.com/1.jar;md5;bb155c3f0133bbce4756ad52003f5968",
      },
    ]);
    const source = findSource(result, "fok");

    expect(source.capability).toBe("supported");
    expect(source.siteProtocol).toBe("xbpq");
    expect(source.enabled).toBe(true);
    expect(source.capabilityNote).toContain("XBPQ");
  });

  it("recognises the family when ext is a URL rather than inline JSON", () => {
    // The common arrangement: 64 of the 68 real payloads are URLs. The config cannot be fetched
    // during import, so the api is what identifies it.
    const result = parse([
      {
        key: "奈飞中文",
        name: "🎗┃奈飞┃秒播",
        type: 3,
        api: "csp_XYQHiker",
        ext: "http://qrh.yimkj.cn/ym/lib/nfzw.json",
        jar: "http://qrh.yimkj.cn/ym/lib/ttkx.jar",
      },
    ]);
    const source = findSource(result, "奈飞中文");

    expect(source.capability).toBe("supported");
    expect(source.siteProtocol).toBe("xbpq");
  });

  it("recognises the key:value serialization csp_Panda uses", () => {
    // The same vocabulary, written as `key:value` pairs instead of JSON.
    const result = parse([
      {
        key: "短剧",
        name: "短剧",
        type: 3,
        api: "csp_Panda",
        ext: "分类url:http://web.zzdj.cc/index.php/vod/show/id/{cateId}/page/{catePg}.html,分类:快手$2#抖音$3,分类值:2#3",
        jar: "https://example.com/panda.jar",
      },
    ]);
    const source = findSource(result, "短剧");

    expect(source.capability).toBe("supported");
    expect(source.siteProtocol).toBe("xbpq");
  });

  it("does not claim a spider whose ext is unrelated", () => {
    // The exemption must be specific. A spider with a JAR and no declarative vocabulary stays
    // blocked.
    const result = parse([
      {
        key: "some-spider",
        name: "Spider",
        type: 3,
        api: "https://example.com/spider",
        ext: "csp_SomeOtherRuntime",
        jar: "https://example.com/other.jar",
      },
    ]);
    const source = findSource(result, "some-spider");

    expect(source.capability).toBe("blocked");
    expect(source.siteProtocol).toBe("spider");
  });

  it("does not mistake a config URL for a key:value payload", () => {
    // A URL's scheme colon must never be read as a key separator.
    const result = parse([
      {
        key: "plain-spider",
        name: "Spider",
        type: 3,
        api: "https://example.com/api",
        ext: "https://example.com/config.json",
        jar: "https://example.com/x.jar",
      },
    ]);
    const source = findSource(result, "plain-spider");

    expect(source.capability).toBe("blocked");
  });

  it("keeps the AppMao family blocked, because its payload is encrypted", () => {
    // AppMao's ext is base64 of high-entropy bytes that no standard codec decodes; the key lives
    // in the companion JAR. Reading it would require executing remote code.
    const result = parse([
      {
        key: "南坊",
        name: "🎃┃南坊┃App",
        type: 3,
        api: "csp_AppMao",
        ext: "FbjDcUxPqpfNr0QF4QvE6sExbd4UXJxJXzdL462ywU1XScGa5G6Hj0/c+Ou1GW6rdX6N2XIhnD46QzIsRoZ8bk4fG4OYi0iCaWwRj2ddkaI+FqHtLjQhalHqIy0+kpiTv2eOfJYxTshgoxEZvRX9BA0UIrOurFxHa4dPZw==",
        jar: "https://example.com/appmao.jar",
      },
    ]);
    const source = findSource(result, "南坊");

    expect(source.capability).toBe("blocked");
  });
});
