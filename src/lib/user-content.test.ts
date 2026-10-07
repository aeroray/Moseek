import { describe, expect, it } from "vitest";
import { normalizeLiveFavorite, normalizeVodFavorite } from "@/lib/user-content";

describe("external user snapshots", () => {
  it("drops empty or wrongly typed work and channel snapshots", () => {
    for (const item of [null, {}, [], "bad", { id: 1, name: "bad" }]) {
      expect(normalizeVodFavorite({ key: "x", item })).toBeNull();
      expect(normalizeLiveFavorite({ key: "x", channel: item })).toBeNull();
    }
  });
  it("recovers old snapshots and sanitizes nested lists and progress", () => {
    const result = normalizeVodFavorite({ key: "src:1", sourceKey: "src", item: { id: "1", name: "作品", actors: [null, "演员"], categories: [null],
      playLines: [null, { id: "line", name: "线路", episodes: [null, { id: "ep", name: "第一集", url: "https://example.com/a.mp4" }] }] },
      progress: { lineId: "line", episodeId: "ep", seconds: "123" } });
    expect(result?.item.sourceKey).toBe("src");
    expect(result?.item.actors).toEqual(["演员"]);
    expect(result?.item.categories).toEqual([]);
    expect(result?.item.playLines[0].episodes).toHaveLength(1);
    expect(result?.progress?.seconds).toBe(0);
  });
});
