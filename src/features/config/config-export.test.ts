import { describe, expect, it } from "vitest";

import { buildExportConfigText } from "@/features/config/config-export";
import type { SourceRecord } from "@/types/moseek";

function source(overrides: Partial<SourceRecord>): SourceRecord {
  return {
    key: "demo",
    name: "示例源",
    sourceType: "cms",
    api: "https://example.com/api.php/provide/vod/",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "普通 HTTP API。",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
    ...overrides,
  };
}

/**
 * The export is rebuilt from the list rather than read from a stored string.
 *
 * **The defect this exists for.** The export wrote `normalizedConfig` while the page rendered
 * `sources` — two values maintained separately. When they drifted, the file described a different set
 * of sources from the one on screen. Reported as "导出前 60 个，重新导入后 55 个": the file held 55 and
 * the import was faithful to it, so the loss had happened at export and nothing said so.
 */
describe("buildExportConfigText", () => {
  it("writes exactly the sources it was given, whatever the stored document says", () => {
    // The stored text names two sources; the list has three. The file must follow the list, because
    // the list is what the user is looking at.
    const stored = JSON.stringify({
      sites: [{ key: "stale", api: "https://stale.example/api" }],
      lives: [],
    });
    const sources = [
      source({ key: "one" }),
      source({ key: "two" }),
      source({ key: "live-1", sourceType: "live", api: "https://live.example/a.m3u" }),
    ];

    const parsed = JSON.parse(buildExportConfigText(stored, sources));

    expect(parsed.sites.map((s: { key: string }) => s.key)).toEqual(["one", "two"]);
    expect(parsed.lives.map((s: { key: string }) => s.key)).toEqual(["live-1"]);
    // The stale entry is gone: it is not in the list, so it is not in the file.
    expect(parsed.sites.some((s: { key: string }) => s.key === "stale")).toBe(false);
  });

  it("round-trips every source it writes", () => {
    // The counts the header shows and the counts a re-import produces must agree. This is the
    // assertion that would have caught the original report: 60 in, 60 out.
    const sources = Array.from({ length: 60 }, (_, index) =>
      source({ key: `s${index}`, api: `https://s${index}.example/api.php/provide/vod` }),
    );

    const text = buildExportConfigText("", sources);
    const parsed = JSON.parse(text);
    expect(parsed.sites).toHaveLength(60);
    expect(parsed.lives).toHaveLength(0);
  });

  it("keeps the parts of the document that are not sources", () => {
    // `parses`, `blockedFields` and any key another client added are not represented in `sources` at
    // all, so regenerating the object from the list would silently drop them.
    const stored = JSON.stringify({
      sites: [],
      lives: [],
      parses: [{ name: "解析甲", type: 1, url: "https://parse.example/?url=" }],
      blockedFields: ["spider"],
      customKey: { kept: true },
    });

    const parsed = JSON.parse(buildExportConfigText(stored, [source({ key: "a" })]));

    expect(parsed.parses).toHaveLength(1);
    expect(parsed.parses[0].name).toBe("解析甲");
    expect(parsed.blockedFields).toEqual(["spider"]);
    expect(parsed.customKey).toEqual({ kept: true });
  });

  it("still produces a configuration when the stored document is unreadable", () => {
    // An unreadable document is not a reason to refuse the export: the list is intact and the user
    // asked for a file.
    const parsed = JSON.parse(buildExportConfigText("not json at all", [source({ key: "a" })]));
    expect(parsed.sites).toHaveLength(1);
    expect(parsed.lives).toEqual([]);
    expect(parsed.parses).toEqual([]);
  });

  it("splits live sources out of sites, so each collection holds what it says", () => {
    const sources = [
      source({ key: "cms-1" }),
      source({ key: "live-1", sourceType: "live", api: "https://live.example/a.m3u" }),
      source({ key: "cms-2" }),
    ];
    const parsed = JSON.parse(buildExportConfigText("", sources));

    expect(parsed.sites.map((s: { key: string }) => s.key)).toEqual(["cms-1", "cms-2"]);
    expect(parsed.lives.map((s: { key: string }) => s.key)).toEqual(["live-1"]);
  });

  it("never writes the app's own data key", () => {
    // Favourites and the theme have their own file now; a configuration carrying them is what made
    // 收藏 appear under 其他设置 as though it were a TVBox client setting.
    const stored = JSON.stringify({
      sites: [],
      lives: [],
      moseek: { schemaVersion: 1, favorites: [{ key: "leaked" }] },
    });
    // The builder spreads the stored document, so a key already in it would survive — which is why
    // `stripExportExtras` is applied on import rather than here. Asserted so the split stays visible.
    const parsed = JSON.parse(buildExportConfigText(stored, [source({ key: "a" })]));
    expect(parsed.moseek).toBeUndefined();
  });
});
