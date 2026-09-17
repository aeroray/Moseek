import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeTitle, relinkFavorite } from "@/features/browse/favorite-relink";
import type { SourceRecord, VodItem } from "@/types/moseek";

const searchVod = vi.fn();
const getVodDetail = vi.fn();

vi.mock("@/features/browse/cms-adapter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/browse/cms-adapter")>();
  return {
    ...actual,
    searchVod: (...args: unknown[]) => searchVod(...args),
    getVodDetail: (...args: unknown[]) => getVodDetail(...args),
  };
});

function source(key: string, name: string): SourceRecord {
  return {
    key,
    name,
    sourceType: "cms",
    api: "https://cms.example/api.php/provide/vod",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "demo",
    enabled: true,
    testStatus: "passed",
    lastCheckedAt: "now",
    requestCount: 0,
  } as SourceRecord;
}

function work(
  name: string,
  sourceKey: string,
  lines: { id: string; name: string }[],
): VodItem {
  return {
    id: "vod-1",
    sourceKey,
    sourceName: sourceKey,
    name,
    poster: "",
    description: "",
    year: "",
    area: "",
    categories: [],
    actors: [],
    directors: [],
    playLines: lines.map((line) => ({
      id: line.id,
      name: line.name,
      episodes: [{ id: `${line.id}-ep`, name: "第01集", url: "https://cdn/1.m3u8" }],
    })),
  };
}

describe("relinkFavorite", () => {
  beforeEach(() => {
    searchVod.mockReset();
    getVodDetail.mockReset();
  });

  it("uses the detail request, not the search row, so every line is available", async () => {
    // The list API usually returns a single line — often a preview — while the detail request
    // returns all of them. Relinking on the search row alone is exactly why a relinked favourite
    // showed one line and offered nothing to switch to.
    searchVod.mockResolvedValue({
      data: {
        sourceKey: "cms-backup",
        items: [work("示例剧", "cms-backup", [{ id: "line-1", name: "线路一" }])],
        categories: [],
        page: 1,
        pageCount: 1,
        pageSize: 10,
        total: 1,
      },
      mode: "remote",
      error: null,
    });
    getVodDetail.mockResolvedValue({
      data: work("示例剧", "cms-backup", [
        { id: "line-1", name: "线路一" },
        { id: "line-2", name: "线路二" },
      ]),
      mode: "remote",
      error: null,
    });

    const result = await relinkFavorite(
      work("示例剧", "cms-main", [{ id: "line-1", name: "线路一" }]),
      [source("cms-main", "主用影视源"), source("cms-backup", "备用影视源")],
      "cms-main",
    );

    expect(result?.item.playLines).toHaveLength(2);
    expect(result?.source.key).toBe("cms-backup");
  });

  it("falls back to the search row when the detail request yields nothing", async () => {
    // A thin source that cannot serve detail should still be usable rather than rejected.
    searchVod.mockResolvedValue({
      data: {
        sourceKey: "cms-backup",
        items: [work("示例剧", "cms-backup", [{ id: "line-1", name: "线路一" }])],
        categories: [],
        page: 1,
        pageCount: 1,
        pageSize: 10,
        total: 1,
      },
      mode: "remote",
      error: null,
    });
    getVodDetail.mockResolvedValue({ data: null, mode: "empty", error: "无详情" });

    const result = await relinkFavorite(
      work("示例剧", "cms-main", [{ id: "line-1", name: "线路一" }]),
      [source("cms-main", "主用影视源"), source("cms-backup", "备用影视源")],
      "cms-main",
    );

    expect(result?.item.playLines).toHaveLength(1);
  });

  it("skips the source the favourite came from", async () => {
    // Its snapshot already failed, so asking it again would only repeat the failure.
    searchVod.mockResolvedValue({
      data: {
        sourceKey: "cms-main",
        items: [work("示例剧", "cms-main", [{ id: "line-1", name: "线路一" }])],
        categories: [],
        page: 1,
        pageCount: 1,
        pageSize: 10,
        total: 1,
      },
      mode: "remote",
      error: null,
    });

    const result = await relinkFavorite(
      work("示例剧", "cms-main", [{ id: "line-1", name: "线路一" }]),
      [source("cms-main", "主用影视源")],
      "cms-main",
    );

    expect(result).toBeNull();
    expect(searchVod).not.toHaveBeenCalled();
  });

  it("does not accept a different work that merely shares a prefix", async () => {
    // Playing the wrong work is worse than finding nothing.
    searchVod.mockResolvedValue({
      data: {
        sourceKey: "cms-backup",
        items: [
          work("示例剧第二季", "cms-backup", [{ id: "line-1", name: "线路一" }]),
        ],
        categories: [],
        page: 1,
        pageCount: 1,
        pageSize: 10,
        total: 1,
      },
      mode: "remote",
      error: null,
    });

    const result = await relinkFavorite(
      work("示例剧", "cms-main", [{ id: "line-1", name: "线路一" }]),
      [source("cms-main", "主用影视源"), source("cms-backup", "备用影视源")],
      "cms-main",
    );

    expect(result).toBeNull();
  });
});

describe("normalizeTitle", () => {
  it("strips the decorations sources add", () => {
    const canonical = normalizeTitle("庆余年");
    expect(normalizeTitle("庆余年[完结]")).toBe(canonical);
    expect(normalizeTitle("庆余年（高清）")).toBe(canonical);
  });
});
