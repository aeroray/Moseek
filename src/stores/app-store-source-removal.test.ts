import { beforeEach, describe, expect, it, vi } from "vitest";

// The store's `removeSources` calls the Tauri command, so it is mocked here. Only the local cleanup
// is under test; what the backend does to the stored document is covered by the Rust tests.
vi.mock("@/lib/tauri", () => ({
  removeSources: vi.fn(async () => ({
    id: 1,
    name: "主配置",
    rawConfig: "{}",
    normalizedConfig: "{}",
    sources: [],
    sourceCount: 0,
    liveCount: 0,
    importedAt: "2026-01-01T00:00:00.000Z",
    sourceBaseUrl: null,
  })),
  setSourceEnabled: vi.fn(async () => null),
}));

import { useAppStore } from "@/stores/app-store";
import type {
  LiveChannel,
  LiveFavorite,
  SourceRecord,
  SourceType,
} from "@/types/moseek";

function source(key: string, sourceType: SourceType = "live"): SourceRecord {
  return {
    key,
    name: `源 ${key}`,
    sourceType,
    api: `https://${key}.example/api`,
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
  };
}

function channel(sourceKey: string): LiveChannel {
  return {
    id: `${sourceKey}:c1`,
    name: "测试频道",
    groupId: "g",
    groupName: "分组",
    logoUrl: "",
    streamUrl: "https://live.example/c1.m3u8",
    streamUrls: ["https://live.example/c1.m3u8"],
    mediaKind: "hls",
    sourceKey,
  };
}

function liveFavorite(sourceKey: string): LiveFavorite {
  return {
    key: `${sourceKey}:c1`,
    channel: channel(sourceKey),
    sourceKey,
    sourceName: `源 ${sourceKey}`,
    savedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("removing a source", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeConfigId: 1,
      sources: [],
      favorites: [],
      liveFavorites: [],
      history: [],
      playbackProgress: {},
      configDocuments: [],
      configDocumentCache: {},
    });
  });

  it("clears a channel favourite that pointed at the removed source", async () => {
    // The dialog promises "相关收藏和播放记录会一并清理", and a channel favourite is a 收藏. It
    // carries `sourceKey` exactly as a work favourite does, so leaving it behind points the entry
    // at a source that no longer exists.
    useAppStore.setState({
      sources: [source("live-1"), source("live-2")],
      liveFavorites: [liveFavorite("live-1")],
    });

    await useAppStore.getState().removeSources(["live-1"]);

    expect(useAppStore.getState().liveFavorites).toHaveLength(0);
  });

  it("keeps a channel favourite from a source that was not removed", async () => {
    useAppStore.setState({
      sources: [source("live-1"), source("live-2")],
      liveFavorites: [liveFavorite("live-2")],
    });

    await useAppStore.getState().removeSources(["live-1"]);

    expect(useAppStore.getState().liveFavorites.map((f) => f.sourceKey)).toEqual([
      "live-2",
    ]);
  });
});
