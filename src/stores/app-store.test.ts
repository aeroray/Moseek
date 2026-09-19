import { beforeEach, describe, expect, it } from "vitest";

import {
  migrateFavorites,
  migrateHistory,
  migrateLiveFavorites,
  migrateSources,
  useAppStore,
} from "@/stores/app-store";
import type { LiveChannel, SourceRecord, VodItem } from "@/types/moseek";

function storedSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
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

describe("capability migration", () => {
  it("rewrites the removed 部分支持 state instead of rendering it", () => {
    // `partial` was deleted from CapabilityStatus because nothing could produce it. Documents
    // written by an older version still carry it, and rendering it literally is what put 部分支持
    // on rows whose adapter column said 没有可用适配器.
    const [migrated] = migrateSources([
      storedSource({ capability: "partial" as never }),
    ]);

    expect(migrated.capability).toBe("needs-adapter");
  });

  it("leaves every state the current model can produce untouched", () => {
    for (const capability of [
      "supported",
      "needs-adapter",
      "blocked",
      "invalid",
    ] as const) {
      const [migrated] = migrateSources([storedSource({ capability })]);
      expect(migrated.capability).toBe(capability);
    }
  });

  it("folds an unrecognised value to invalid rather than guessing", () => {
    // A value the model cannot interpret is a record that cannot be trusted; `invalid` says so,
    // and inventing a friendlier word would hide that.
    const [migrated] = migrateSources([
      storedSource({ capability: "something-else" as never }),
    ]);

    expect(migrated.capability).toBe("invalid");
  });

  it("returns the same object when nothing needed changing", () => {
    // The list is rendered on every keystroke, so an unconditional copy would churn identities.
    const source = storedSource({ capability: "supported" });
    const [migrated] = migrateSources([source]);

    expect(migrated).toBe(source);
  });

  it("survives a missing or malformed list", () => {
    expect(migrateSources(undefined)).toEqual([]);
    expect(migrateSources(null as never)).toEqual([]);
  });
});

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

describe("history migration", () => {
  it("tags records saved before footprints carried a kind", () => {
    // The old shape was a flat record with an `item` and no `kind`.
    const migrated = migrateHistory([
      {
        id: "vod-1:ep-1",
        item: legacyItem(),
        lineId: "line-1",
        episodeId: "ep-1",
        episodeName: "第01集",
        progress: 120,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    expect(migrated).toHaveLength(1);
    expect(migrated[0].kind).toBe("vod");
    // The id is kept exactly, because `playbackProgress` is keyed by it — rewriting it would
    // orphan every saved position.
    expect(migrated[0].id).toBe("vod-1:ep-1");
  });

  it("leaves already-migrated records untouched", () => {
    const current = [
      {
        kind: "live" as const,
        id: "live-main:News",
        channel: {
          id: "live-main:News",
          name: "City News",
          groupId: "news",
          groupName: "新闻",
          logoUrl: "",
          streamUrl: "https://s/n.m3u8",
          streamUrls: ["https://s/n.m3u8"],
          mediaKind: "hls" as const,
          sourceKey: "live-main",
        },
        sourceName: "直播源",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    expect(migrateHistory(current)).toHaveLength(1);
    expect(migrateHistory(current)[0].kind).toBe("live");
  });

  it("survives a corrupt or missing value", () => {
    expect(migrateHistory(undefined)).toEqual([]);
    expect(migrateHistory(null)).toEqual([]);
    expect(migrateHistory("nonsense")).toEqual([]);
    expect(migrateHistory([null, 7, {}])).toEqual([]);
  });
});

function liveChannel(name: string): LiveChannel {
  return {
    id: `live-main:${name}`,
    name,
    groupId: "news",
    groupName: "新闻",
    logoUrl: "",
    streamUrl: "https://s/n.m3u8",
    streamUrls: ["https://s/n.m3u8"],
    mediaKind: "hls",
    sourceKey: "live-main",
  };
}

describe("footprints", () => {
  beforeEach(() => {
    useAppStore.setState({ history: [], playbackProgress: {} });
  });

  it("records a work under the key playback progress uses", () => {
    // `setPlaybackProgress` finds the record to update by id. If the two schemes disagree the
    // position is written to the map but never reaches the timeline, and the page silently shows
    // "刚开始看" forever.
    useAppStore.getState().addVodFootprint({
      item: legacyItem(),
      lineId: "line-1",
      episodeId: "ep-1",
      episodeName: "第01集",
      progress: 0,
    });

    const record = useAppStore.getState().history[0];
    expect(record.id).toBe("vod-1:ep-1");

    useAppStore.getState().setPlaybackProgress(record.id, 620);
    const updated = useAppStore.getState().history[0];
    if (updated.kind !== "vod") throw new Error("expected a vod footprint");
    expect(updated.progress).toBe(620);
  });

  it("keeps only the newest entry for the same episode", () => {
    // Re-opening something should move it to the top, not add a second row for the same visit.
    const footprint = {
      item: legacyItem(),
      lineId: "line-1",
      episodeId: "ep-1",
      episodeName: "第01集",
      progress: 0,
    };
    useAppStore.getState().addVodFootprint(footprint);
    useAppStore.getState().addVodFootprint({ ...footprint, episodeId: "ep-2" });
    useAppStore.getState().addVodFootprint(footprint);

    const history = useAppStore.getState().history;
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe("vod-1:ep-1");
  });

  it("records a channel without a position", () => {
    // A channel is live; giving it a resume point would be meaningless.
    useAppStore.getState().addLiveFootprint(liveChannel("City News"), "直播源");

    const record = useAppStore.getState().history[0];
    expect(record.kind).toBe("live");
    if (record.kind !== "live") throw new Error("expected a live footprint");
    expect(record.channel.name).toBe("City News");
    expect(record.sourceName).toBe("直播源");
  });

  it("does not corrupt a live record when progress is reported", () => {
    // The live record has no `progress` field, so the update has to skip it rather than write one.
    useAppStore.getState().addLiveFootprint(liveChannel("City News"), "直播源");
    const id = useAppStore.getState().history[0].id;

    useAppStore.getState().setPlaybackProgress(id, 30);

    const record = useAppStore.getState().history[0];
    expect(record.kind).toBe("live");
    expect(record).not.toHaveProperty("progress");
  });
});
