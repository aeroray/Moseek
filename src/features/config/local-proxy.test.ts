import { describe, expect, it } from "vitest";

import { parseConfigText, unwrapLocalProxyUrl } from "@/features/config/config-parser";

// Published TVBox configurations routinely route every source through the TVBox client's own
// loopback proxy: `http://127.0.0.1:9978/proxy?do=live&url=<real address>`. That address only
// resolves while the TVBox app is running here, so requesting it fails — and the failure is
// reported by the address policy as "local addresses are not authorised", which describes our
// rule rather than the actual problem. The `url` parameter holds the real address.
describe("local proxy unwrapping", () => {
  it("unwraps a TVBox live proxy into the address it points at", () => {
    expect(
      unwrapLocalProxyUrl(
        "http://127.0.0.1:9978/proxy?do=live&url=https://x.szyyds.cn/bililive.m3u",
      ),
    ).toBe("https://x.szyyds.cn/bililive.m3u");
  });

  it("unwraps a proxy on localhost as well as the loopback address", () => {
    expect(
      unwrapLocalProxyUrl(
        "http://localhost:9978/proxy?do=live&url=https://example.com/list.m3u",
      ),
    ).toBe("https://example.com/list.m3u");
  });

  it("leaves an ordinary remote address alone", () => {
    const url = "https://example.com/api.php/provide/vod/";
    expect(unwrapLocalProxyUrl(url)).toBe(url);
  });

  it("does not treat a remote host's url parameter as a wrapper", () => {
    // Only a loopback host is a local proxy. A real server that happens to take a `url`
    // parameter must be requested as given.
    const url = "https://example.com/proxy?url=https://other.example/x.m3u";
    expect(unwrapLocalProxyUrl(url)).toBe(url);
  });

  it("keeps the original when the proxy carries no usable target", () => {
    // Rewriting to nothing would silently break a source that might still work.
    for (const url of [
      "http://127.0.0.1:9978/proxy?do=live",
      "http://127.0.0.1:9978/proxy?url=not-a-url",
      "http://127.0.0.1:9978/proxy?url=file:///etc/passwd",
    ]) {
      expect(unwrapLocalProxyUrl(url), url).toBe(url);
    }
  });

  it("leaves non-http values untouched", () => {
    expect(unwrapLocalProxyUrl("./libs/tv/tvlive.txt")).toBe("./libs/tv/tvlive.txt");
    expect(unwrapLocalProxyUrl("proxy://demo")).toBe("proxy://demo");
  });

  it("is applied to live sources while parsing a configuration", () => {
    // The end-to-end effect: a configuration using the TVBox proxy yields a source pointing at
    // the real address, so testing it reaches the site instead of failing on our own rule.
    const result = parseConfigText(
      JSON.stringify({
        lives: [
          {
            name: "肥羊B站直播",
            url: "http://127.0.0.1:9978/proxy?do=live&url=https://x.szyyds.cn/bililive.m3u",
          },
        ],
      }),
    );

    const source = result.sources[0];
    expect(source.api).toBe("https://x.szyyds.cn/bililive.m3u");
    expect(source.capability).toBe("supported");
  });

  it("is applied to cms sources too", () => {
    const result = parseConfigText(
      JSON.stringify({
        sites: [
          {
            key: "proxied",
            name: "经代理的 CMS",
            api: "http://127.0.0.1:9978/proxy?url=https://example.com/api.php/provide/vod/",
          },
        ],
      }),
    );

    expect(result.sources[0].api).toBe(
      "https://example.com/api.php/provide/vod/",
    );
  });
});
