import { describe, expect, it } from "vitest";

import {
  migrateFavorites,
  migrateLiveFavorites,
} from "@/stores/app-store";
import type { VodItem } from "@/types/moseek";

function legacyItem(): VodItem {
  return {
    id: "vod-1",
    sourceKey: "cms-main",
    sourceName: "主用影视源",
    name: "示例剧",
    poster: "",
    description: "",
    year: "2026",
    area: "",
    categories: [],
    actors: [],
    directors: [],
    playLines: [],
  };
}

describe("favourite storage migration", () => {
  it("keeps favourites saved in the old bare-item shape", () => {
    // The old shape was a plain `VodItem[]`. Dropping those entries would silently empty a user's
    // collection on upgrade, which is the worst possible outcome of a schema change.
    const migrated = migrateFavorites([legacyItem()]);
    expect(migrated).toHaveLength(1);
    expect(migrated[0].key).toBe("cms-main:vod-1");
    expect(migrated[0].item.name).toBe("示例剧");
    expect(migrated[0].sourceName).toBe("主用影视源");
    // The old shape never stored a position, so there is none to recover.
    expect(migrated[0].progress).toBeNull();
  });

  it("leaves already-migrated favourites untouched", () => {
    const current = [
      {
        key: "cms-main:vod-1",
        item: legacyItem(),
        sourceKey: "cms-main",
        sourceName: "主用影视源",
        savedAt: "2026-01-01T00:00:00.000Z",
        progress: {
          lineId: "line-1",
          episodeId: "ep-2",
          episodeName: "第02集",
          seconds: 620,
          episodeCount: 3,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    ];
    const migrated = migrateFavorites(current);
    expect(migrated).toHaveLength(1);
    // The saved position survives: losing your place on upgrade is not acceptable.
    expect(migrated[0].progress?.seconds).toBe(620);
  });

  it("survives a corrupt or missing value", () => {
    expect(migrateFavorites(undefined)).toEqual([]);
    expect(migrateFavorites(null)).toEqual([]);
    expect(migrateFavorites("nonsense")).toEqual([]);
    expect(migrateFavorites([null, 42, {}])).toEqual([]);
  });

  it("drops live favourites saved as bare ids", () => {
    // A string alone carries no channel, so it cannot be turned into something playable. A
    // broken entry that looks like a favourite is worse than no entry.
    expect(migrateLiveFavorites(["live-main:News:City News"])).toEqual([]);
    expect(migrateLiveFavorites(undefined)).toEqual([]);
  });

  it("keeps live favourites that carry their channel", () => {
    const saved = [
      {
        key: "live-main:News:City News",
        channel: {
          id: "live-main:News:City News",
          name: "City News",
          groupId: "news",
          groupName: "新闻",
          logoUrl: "",
          streamUrl: "https://stream.example/news.m3u8",
          streamUrls: ["https://stream.example/news.m3u8"],
          mediaKind: "hls" as const,
          sourceKey: "live-main",
        },
        sourceKey: "live-main",
        sourceName: "直播源",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const migrated = migrateLiveFavorites(saved);
    expect(migrated).toHaveLength(1);
    expect(migrated[0].channel.name).toBe("City News");
  });
});
