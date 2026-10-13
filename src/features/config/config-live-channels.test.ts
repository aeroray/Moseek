import { describe, expect, it } from "vitest";

import { parseConfigText, unwrapLiveProxyLine } from "@/features/config/config-parser";

/**
 * TVBox's `channels` line list, and the `proxy://` form one of its lines uses.
 *
 * **Why this exists.** A published configuration can carry several selectable lines for one live entry
 * instead of a single `url`:
 *
 *     {"channels": [{"name": "live", "urls": ["proxy://do=live&type=txt&ext=<base64>"]}],
 *      "group": "redirect"}
 *
 * Moseek read only `url`/`source`/`api`, so such an entry arrived with no address and was reported as
 * `直播源缺少 name 或 url/api 字段` — a source that works in other clients, shown here as an empty row
 * named `直播源 14` by the positional fallback. Found in the user's own database, and the fixture below
 * is that entry verbatim.
 */
const USER_LINE =
  "proxy://do=live&type=txt&ext=aHR0cDovL2hvbWUuanVuZGllLnRvcDo4MS9DYXQvdHYvbGl2ZS50eHQ=";

describe("a proxy:// live line", () => {
  it("decodes the base64 ext into the address it points at", () => {
    // Measured: this is the value the user's entry actually holds, and the host is one their other
    // working live sources use.
    expect(unwrapLiveProxyLine(USER_LINE)).toBe("http://home.jundie.top:81/Cat/tv/live.txt");
  });

  it("accepts the URL-safe base64 alphabet and missing padding", () => {
    // Producers differ, and both spellings appear. `atob` rejects the URL-safe alphabet and unpadded
    // input, so both are normalised before decoding.
    const standard = Buffer.from("https://example.com/a.m3u").toString("base64");
    const urlsafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(unwrapLiveProxyLine(`proxy://do=live&ext=${standard}`)).toBe("https://example.com/a.m3u");
    expect(unwrapLiveProxyLine(`proxy://do=live&ext=${urlsafe}`)).toBe("https://example.com/a.m3u");
  });

  it("keeps a template suffix that follows the base64 head", () => {
    // Some lines append `?ch={name}` for the guide provider. Dropping it would lose a per-channel
    // address the user configured.
    const head = Buffer.from("https://example.com/list.txt").toString("base64");
    expect(unwrapLiveProxyLine(`proxy://do=live&ext=${head}?ch={name}&date={date}`)).toBe(
      "https://example.com/list.txt?ch={name}&date={date}",
    );
  });

  it("leaves a proxy that is not a playlist alone", () => {
    // `do=parse` and friends point at TVBox's own server. Returning an address for them would claim
    // the source is usable when nothing here can fetch it — so they stay wrapped and are classified
    // as a private protocol, which is the honest answer.
    const encoded = Buffer.from("https://example.com/page").toString("base64");
    const line = `proxy://do=parse&ext=${encoded}`;
    expect(unwrapLiveProxyLine(line)).toBe(line);
  });

  it("refuses a payload pointing at this machine", () => {
    // The base64 sometimes holds the other spelling of a local proxy. That address only resolves
    // while TVBox is running, so treating it as usable would be a lie the user pays for later.
    for (const local of [
      "http://127.0.0.1:9978/proxy",
      "http://localhost:9978/x",
      "http://10.0.0.5/list.m3u",
      "http://192.168.1.20/list.m3u",
      "http://172.16.4.4/list.m3u",
    ]) {
      const encoded = Buffer.from(local).toString("base64");
      const line = `proxy://do=live&ext=${encoded}`;
      expect(unwrapLiveProxyLine(line), local).toBe(line);
    }
  });

  it("leaves anything it cannot decode exactly as it was", () => {
    // Failing to understand a value is not evidence that it is unusable, and this function's only real
    // risk is claiming an address that does not exist.
    for (const value of [
      "proxy://do=live&ext=not-base64!!!",
      "proxy://do=live",
      "proxy://wexian/1",
      "http://127.0.0.1:9978/proxy?do=live&url=https://x.example/a.m3u",
      "https://normal.example/a.m3u",
      "",
    ]) {
      expect(unwrapLiveProxyLine(value), value).toBe(value);
    }
  });
});

describe("a live entry that carries channels", () => {
  const configWith = (live: unknown) =>
    JSON.stringify({ sites: [], lives: [live] });

  it("reads the first usable line as the source's address", () => {
    // **The defect this exists for.** Before this, the entry parsed with `api: ""` and capability
    // `invalid`, and the user saw a working source reported as missing its address.
    const result = parseConfigText(
      configWith({
        channels: [{ name: "live", urls: [USER_LINE] }],
        epg: "http://epg.51zmt.top:8000/api/diyp/",
        group: "redirect",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.sources[0]?.api).toBe("http://home.jundie.top:81/Cat/tv/live.txt");
    // And it must be usable, not merely present: a row showing an address but refusing to load it
    // would be the same problem wearing a different label.
    expect(result.sources[0]?.capability).toBe("supported");
    expect(result.sources[0]?.enabled).toBe(true);
  });

  it("prefers a plain address over the line list when the entry states both", () => {
    // `url` is unambiguous; the lines are only a fallback.
    const result = parseConfigText(
      configWith({
        name: "两条都有",
        url: "https://direct.example/a.m3u",
        channels: [{ name: "live", urls: [USER_LINE] }],
      }),
    );

    expect(result.sources[0]?.api).toBe("https://direct.example/a.m3u");
  });

  it("skips lines it cannot use rather than giving up on the entry", () => {
    const result = parseConfigText(
      configWith({
        channels: [
          { name: "bad", urls: ["proxy://do=parse&ext=eA=="] },
          { name: "good", urls: [USER_LINE] },
        ],
      }),
    );

    expect(result.sources[0]?.api).toBe("http://home.jundie.top:81/Cat/tv/live.txt");
  });

  it("still reports an entry whose lines hold nothing usable", () => {
    // The other direction: the fix must not turn every unreadable entry into a usable one.
    const result = parseConfigText(
      configWith({ channels: [{ name: "empty" }], epg: "http://epg.example/" }),
    );

    expect(result.ok).toBe(true);
    expect(result.sources[0]?.api).toBe("");
    expect(result.sources[0]?.capability).toBe("invalid");
  });

  it("does not fail the document on a malformed line list", () => {
    // This part of a configuration is not modelled by the schema, so a shapes it did not expect must
    // not take the whole file down with it.
    for (const channels of ["not-an-array", [null], [{ urls: "not-an-array" }], [{ urls: [42, null] }]]) {
      const result = parseConfigText(configWith({ name: "形状奇怪", channels }));
      expect(result.ok, JSON.stringify(channels)).toBe(true);
    }
  });
});
