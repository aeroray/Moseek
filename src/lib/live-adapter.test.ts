import { describe, expect, it } from "vitest";

import {
  DEFAULT_EPG_TEMPLATE,
  findCurrentProgram,
  findNextProgram,
  isPlaceholderGuide,
  resolveEpgRequest,
  resolveEpgUrl,
} from "@/lib/live-adapter";
import type { EpgProgram } from "@/types/moseek";

describe("EPG template resolution", () => {
  const channel = { name: "CCTV1", epgId: undefined };
  const july2026 = new Date(2026, 6, 15);

  it("substitutes the channel name and date into a TVBox template", () => {
    // The TVBox `epg` field is a template. Sending it verbatim made 112114 answer for the
    // literal channel "{name}" and return a generic placeholder for every channel.
    expect(
      resolveEpgUrl(
        "https://epg.112114.xyz/?ch={name}&date={date}",
        channel,
        july2026,
      ),
    ).toBe("https://epg.112114.xyz/?ch=CCTV1&date=2026-07-15");
  });

  it("prefers the tvg-id when the channel carries one", () => {
    expect(
      resolveEpgUrl(
        "https://epg.example/?ch={name}",
        { name: "CCTV-1 综合", epgId: "CCTV1.cn" },
        july2026,
      ),
    ).toBe("https://epg.example/?ch=CCTV1.cn");
  });

  it("leaves a fixed URL untouched so XMLTV guides keep working", () => {
    const fixed = "https://live.example/guide.xml";
    expect(resolveEpgUrl(fixed, channel, july2026)).toBe(fixed);
  });

  it("percent-encodes a name that would otherwise break the query string", () => {
    expect(
      resolveEpgUrl("https://epg.example/?ch={name}", {
        name: "CCTV 1&2",
        epgId: undefined,
      }),
    ).toBe("https://epg.example/?ch=CCTV%201%262");
  });

  it("tolerates upper-case placeholders", () => {
    expect(
      resolveEpgUrl("https://epg.example/?ch={NAME}&date={DATE}", channel, july2026),
    ).toBe("https://epg.example/?ch=CCTV1&date=2026-07-15");
  });
});

describe("automatic guide selection", () => {
  it("falls back to the built-in guide when the source declares none", () => {
    // Most public IPTV lists ship no `epg`, and asking a non-technical user to hand-edit a
    // TVBox template just to see what is on air is not a reasonable step.
    expect(resolveEpgRequest({ epg: undefined }, true)).toEqual({
      template: DEFAULT_EPG_TEMPLATE,
      origin: "auto",
    });
  });

  it("lets a source's own guide win over the built-in one", () => {
    expect(
      resolveEpgRequest({ epg: "https://mine.example/guide.xml" }, true),
    ).toEqual({ template: "https://mine.example/guide.xml", origin: "configured" });
  });

  it("does not contact any provider when auto guides are off", () => {
    // Turning the setting off must mean no third-party request at all, not just a hidden UI.
    expect(resolveEpgRequest({ epg: undefined }, false)).toBeNull();
  });

  it("still honours a configured guide when auto guides are off", () => {
    expect(
      resolveEpgRequest({ epg: "https://mine.example/guide.xml" }, false),
    ).toEqual({ template: "https://mine.example/guide.xml", origin: "configured" });
  });

  it("treats a blank epg field as unconfigured", () => {
    expect(resolveEpgRequest({ epg: "   " }, true)?.origin).toBe("auto");
  });
});

describe("placeholder guide detection", () => {
  function program(title: string, startAt: string, endAt: string): EpgProgram {
    return { id: `${title}-${startAt}`, channelId: "CCTV1", title, description: "", startAt, endAt };
  }

  it("rejects the generic filler an unrecognised channel receives", () => {
    // 112114 answers HTTP 200 with a dozen identical "精彩节目" rows for ANY unknown name,
    // including obvious nonsense. Rendering that would claim the guide works while every row
    // said "exciting programming", which is worse than admitting the channel is unlisted.
    const filler = Array.from({ length: 12 }, (_, i) =>
      program("精彩节目", `0${i}:00`, `0${i}:59`),
    );
    expect(isPlaceholderGuide(filler)).toBe(true);
  });

  it("accepts a real guide", () => {
    expect(
      isPlaceholderGuide([
        program("晚间新闻", "01:30", "02:02"),
        program("精彩节目", "02:02", "02:30"),
      ]),
    ).toBe(false);
  });

  it("does not treat an empty guide as a placeholder", () => {
    expect(isPlaceholderGuide([])).toBe(false);
  });
});

describe("current programme selection", () => {
  function program(title: string, startAt: string, endAt: string): EpgProgram {
    return { id: `${title}-${startAt}`, channelId: "CCTV1", title, description: "", startAt, endAt };
  }

  const day = [
    program("人口-2026-37", "01:08", "01:30"),
    program("晚间新闻", "01:30", "02:02"),
    program("家业第28集", "11:01", "11:48"),
    program("非遗里的中国-MV", "11:48", "11:54"),
    program("秘境之眼", "11:54", "12:00"),
  ];

  it("picks the programme airing now, not the first of the day", () => {
    // Providers return the whole day from 00:00. The workspace labelled programs[0] "当前"
    // and showed the 01:08 programme while 11:48 was on air.
    expect(findCurrentProgram(day, new Date(2026, 8, 16, 11, 52))?.title).toBe(
      "非遗里的中国-MV",
    );
  });

  it("treats a programme boundary as the start of the next programme", () => {
    expect(findCurrentProgram(day, new Date(2026, 8, 16, 11, 48))?.title).toBe(
      "非遗里的中国-MV",
    );
  });

  it("returns null when no programme covers the current minute", () => {
    expect(findCurrentProgram(day, new Date(2026, 8, 16, 3, 0))).toBeNull();
  });

  it("finds the next programme to start", () => {
    expect(findNextProgram(day, new Date(2026, 8, 16, 11, 52))?.title).toBe(
      "秘境之眼",
    );
  });

  it("returns null for the next programme once the day is over", () => {
    expect(findNextProgram(day, new Date(2026, 8, 16, 23, 30))).toBeNull();
  });

  it("handles a programme that runs past midnight", () => {
    // A crossing programme's end clock is numerically before its start, so the interval wraps.
    const overnight = [program("午夜剧场", "23:30", "00:30")];
    expect(findCurrentProgram(overnight, new Date(2026, 8, 16, 23, 45))?.title).toBe(
      "午夜剧场",
    );
    expect(findCurrentProgram(overnight, new Date(2026, 8, 16, 0, 15))?.title).toBe(
      "午夜剧场",
    );
    expect(findCurrentProgram(overnight, new Date(2026, 8, 16, 1, 0))).toBeNull();
  });

  it("ignores rows whose clock could not be parsed", () => {
    expect(
      findCurrentProgram([program("未知", "", "")], new Date(2026, 8, 16, 11, 52)),
    ).toBeNull();
  });
});
