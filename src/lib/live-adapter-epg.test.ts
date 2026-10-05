import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadEpg } from "@/lib/live-adapter";
import type { EpgProgram } from "@/types/moseek";

/**
 * The guide a per-channel template returns must be attributed to the channel it was asked about.
 *
 * **This is the defect behind "CCTV-1 获取不到节目单".** The live view filters a guide's programmes by
 * the selected channel's own identifiers (`epgId`, `name`, `id`). A per-channel provider answers with
 * *its own* name for the channel — measured, 51zmt answers a request for `CCTV1` with
 * `channel_name: "CCTV-1综合"` — and that string is not any of the channel's identifiers, so every
 * programme was discarded on the client. The request succeeded and the panel still said the guide was
 * empty, which is exactly what the user saw.
 *
 * `getEpg` is the Rust boundary, so it is what these tests stand in for.
 */
const getEpg = vi.fn();

vi.mock("@/lib/tauri", () => ({
  getEpg: (...args: unknown[]) => getEpg(...args),
}));

/**
 * A template unique to one test.
 *
 * `loadEpg` caches by resolved URL in a module-level map, and that cache is deliberately shared across
 * calls — it is what stops flicking through the channel list re-fetching the same day. In a test file
 * that means two tests using the same template share a cache entry, so the second one silently gets
 * the first one's answer without `getEpg` being consulted. Measured: the retry test saw one call
 * instead of two, and the empty-result test received the previous test's real guide. A distinct host
 * per test keeps them independent, which is what a fresh page load would do.
 */
let templateCounter = 0;
function uniqueTemplate() {
  templateCounter += 1;
  return `http://epg-${templateCounter}.example/?ch={name}&date={date}`;
}

function program(title: string, startAt: string, endAt: string, channelId: string): EpgProgram {
  return { id: `${channelId}-${startAt}`, channelId, title, description: "", startAt, endAt };
}

/** A provider that answers under its own name, the way 51zmt does. */
function providerAnswer(echoedName: string) {
  return {
    programs: [
      program("晚间新闻", "19:00", "19:30", echoedName),
      program("焦点访谈", "19:30", "20:00", echoedName),
    ],
  };
}

describe("attributing a per-channel guide", () => {
  beforeEach(() => {
    getEpg.mockReset();
  });

  it("claims the programmes for the channel that was asked about", async () => {
    // The provider answers under its own spelling, which the client cannot predict.
    getEpg.mockResolvedValue(providerAnswer("CCTV-1综合"));

    const result = await loadEpg(
      { template: uniqueTemplate(), origin: "configured" },
      { name: "CCTV-1", epgId: undefined },
    );

    expect(result.mode).toBe("remote");
    expect(result.data.programs).toHaveLength(2);
    // Claimed for the channel the user selected, so the view's filter finds them.
    expect(
      result.data.programs.every((item) => item.channelId === "CCTV-1"),
    ).toBe(true);
  });

  it("re-keys the programmes so two channels cannot collide", async () => {
    // `id` is derived from `channel_id` by the Rust parser, so leaving it would make two channels'
    // guides share ids in any map keyed by programme id.
    getEpg.mockResolvedValue(providerAnswer("CCTV-1综合"));

    const result = await loadEpg(
      { template: uniqueTemplate(), origin: "configured" },
      { name: "CCTV-1", epgId: undefined },
    );

    expect(result.data.programs.map((item) => item.id)).toEqual([
      "CCTV-1-0",
      "CCTV-1-1",
    ]);
  });

  it("leaves a fixed XMLTV address alone", async () => {
    // A fixed URL genuinely covers many channels; re-labelling it would attribute every channel's
    // programmes to whichever one happened to be selected.
    getEpg.mockResolvedValue({
      programs: [
        program("晚间新闻", "19:00", "19:30", "CCTV1"),
        program("新闻联播", "19:00", "19:30", "CCTV13"),
      ],
    });

    const result = await loadEpg(
      { template: "https://live.example/guide.xml", origin: "configured" },
      { name: "CCTV-1", epgId: undefined },
    );

    expect(result.data.programs.map((item) => item.channelId)).toEqual([
      "CCTV1",
      "CCTV13",
    ]);
  });

  it("retries with the compact spelling when the first attempt finds nothing", async () => {
    // Measured against 51zmt: `CCTV-1` returns the "未提供" filler while `CCTV1` returns the real
    // schedule. The retry is what makes the playlist's own spelling irrelevant.
    getEpg
      .mockResolvedValueOnce({
        programs: [
          program("精彩节目-暂未提供节目预告信息 --免费使用", "00:00", "00:59", "未提供"),
        ],
      })
      .mockResolvedValueOnce(providerAnswer("CCTV-1综合"));

    const result = await loadEpg(
      { template: uniqueTemplate(), origin: "configured" },
      { name: "CCTV-1", epgId: undefined },
    );

    expect(result.mode).toBe("remote");
    expect(result.data.programs).toHaveLength(2);
    // The second request carried the compact name.
    expect(getEpg).toHaveBeenCalledTimes(2);
    expect(String(getEpg.mock.calls[1][0])).toContain("ch=CCTV1");
    // **And the programmes are claimed under the channel's own name, not the substituted one.** The
    // live view filters by the channel the user selected, so labelling them `CCTV1` would have every
    // row dropped on the client — the same failure the claiming step exists to fix, one level down.
    expect(
      result.data.programs.every((item) => item.channelId === "CCTV-1"),
    ).toBe(true);
  });

  it("does not retry when the name is already compact", async () => {
    // Otherwise every correct channel would cost two requests.
    getEpg.mockResolvedValue(providerAnswer("CCTV-1综合"));

    await loadEpg(
      { template: uniqueTemplate(), origin: "configured" },
      { name: "CCTV1", epgId: undefined },
    );

    expect(getEpg).toHaveBeenCalledTimes(1);
  });

  it("reports the first attempt's answer when the retry also fails", async () => {
    // An empty first result is more informative than the retry's: the retry only ran *because* the
    // first was empty, so its failure says nothing new about the channel.
    getEpg.mockResolvedValue({ programs: [] });

    const result = await loadEpg(
      { template: uniqueTemplate(), origin: "configured" },
      { name: "CCTV-1", epgId: undefined },
    );

    expect(result.mode).toBe("empty");
  });

  it("does not retry a failed request against the same provider", async () => {
    // **A defect introduced by the first version of the spelling retry.** `mode` is `empty` both for
    // "the provider answered with nothing" and for "the request threw", so an unreachable host was
    // asked twice for the same channel spelling and the user waited out the timeout twice before being
    // told it failed.
    //
    // The assertion is that no *template* is asked twice, not that `getEpg` is called once: the
    // provider fallback legitimately tries other hosts, and counting calls would confuse the two.
    getEpg.mockRejectedValue(new Error("连接超时"));

    const result = await loadEpg(
      { template: uniqueTemplate(), origin: "configured" },
      { name: "CCTV-1", epgId: undefined },
    );

    expect(result.error).not.toBeNull();
    const requested = getEpg.mock.calls.map((call) => String(call[0]));
    expect(new Set(requested).size).toBe(requested.length);
    // And no request carried the compact spelling, which is what the retry would have sent.
    expect(requested.some((url) => url.includes("ch=CCTV1&"))).toBe(false);
  });

  it("falls back to another provider when the configured one cannot be reached", async () => {
    // **The reported failure: "一直获取失败".** Six of the user's live sources name
    // `epg.112114.xyz`, which is unreachable from their network, so honouring the configured template
    // and stopping meant those channels could never show a guide — even though a working provider for
    // the same channel names was one request away.
    //
    // The configured template is made unreachable so the fallback is what has to answer. If the
    // fallback did not exist, `getEpg` would be called once and the result would be an error.
    getEpg.mockImplementation(async (url: string) => {
      if (!String(url).includes("51zmt")) throw new Error("域名解析超时");
      return providerAnswer("CCTV-1综合");
    });

    const result = await loadEpg(
      { template: uniqueTemplate(), origin: "configured" },
      { name: "CCTV-1", epgId: undefined },
    );

    expect(result.mode).toBe("remote");
    expect(result.data.programs).toHaveLength(2);
    // The working provider was actually tried, and it was not the configured one.
    expect(String(getEpg.mock.calls.at(-1)?.[0])).toContain("51zmt");
  });

  it("keeps the configured provider when it answers", async () => {
    // The fallback must not override a guide the user deliberately chose.
    getEpg.mockResolvedValue(providerAnswer("CCTV-1综合"));

    const result = await loadEpg(
      { template: uniqueTemplate(), origin: "configured" },
      { name: "CCTV-1", epgId: undefined },
    );

    expect(result.mode).toBe("remote");
    expect(getEpg).toHaveBeenCalledTimes(1);
  });

  it("never swaps a fixed XMLTV address for a per-channel template", async () => {
    // One is a whole document in someone else's format; substituting a per-channel template for it
    // would ask an unrelated question and attribute the answer to the wrong channel.
    //
    // The URL is unique to this test for the same reason `uniqueTemplate` is: the guide cache is
    // module-level and shared, so a fixed address reused across tests would answer from cache and the
    // assertion below would pass without a request ever being made — measured, it reported zero calls.
    const fixedUrl = `https://guide-${(templateCounter += 1)}.example/guide.xml`;
    getEpg.mockResolvedValue({ programs: [] });

    await loadEpg(
      { template: fixedUrl, origin: "configured" },
      { name: "CCTV-1", epgId: undefined },
    );

    expect(getEpg).toHaveBeenCalledTimes(1);
    expect(String(getEpg.mock.calls[0][0])).toBe(fixedUrl);
  });
});
