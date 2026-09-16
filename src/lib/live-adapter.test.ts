import { describe, expect, it } from "vitest";

import { resolveEpgUrl } from "@/lib/live-adapter";

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
