import { describe, expect, it } from "vitest";

import {
  normalizeCatVodCategories,
  normalizeCatVodResult,
} from "@/features/script/catvod-normalizer";

const context = {
  sourceKey: "kitty-demo",
  sourceName: "Kitty Demo",
  page: 2,
  pageSize: 10,
};

describe("CatVod output normalizer", () => {
  it("normalizes category text and object shapes", () => {
    expect(
      normalizeCatVodCategories([
        { id: "movie", text: "电影" },
        { type_id: 2, type_name: "电视剧" },
        "综艺",
      ]),
    ).toEqual([
      { id: "movie", name: "电影" },
      { id: "2", name: "电视剧" },
      { id: "3", name: "综艺" },
    ]);
  });

  it("normalizes Kitty catalog items and playlist objects", () => {
    const result = normalizeCatVodResult(
      "getHome",
      {
        total: 1,
        data: [
          {
            id: "movie-1",
            title: "测试影片",
            cover: "https://example.com/poster.jpg",
            desc: "简介",
            playlist: [
              {
                title: "线路一",
                episodes: [
                  {
                    id: "ep-1",
                    name: "正片",
                    url: "https://example.com/a.m3u8",
                  },
                ],
              },
            ],
          },
        ],
      },
      context,
    );

    expect(result.kind).toBe("catalog");
    if (result.kind !== "catalog") return;
    expect(result.value).toMatchObject({ page: 2, pageSize: 10, total: 1 });
    expect(result.value.items[0]).toMatchObject({
      id: "movie-1",
      sourceName: "Kitty Demo",
      name: "测试影片",
      poster: "https://example.com/poster.jpg",
    });
    expect(result.value.items[0]?.playLines[0]?.name).toBe("线路一");
    expect(result.value.items[0]?.playLines[0]?.episodes[0]?.url).toContain(
      "m3u8",
    );
  });

  it("normalizes TVBox playlist delimiter strings", () => {
    const result = normalizeCatVodResult(
      "getDetail",
      {
        vod_id: "tvbox-1",
        vod_name: "兼容影片",
        vod_play_from: "线路一$$$线路二",
        vod_play_url:
          "第一集$https://example.com/one.m3u8#第二集$https://example.com/two.m3u8$$$正片$https://example.com/movie.mp4",
      },
      context,
    );

    expect(result.kind).toBe("detail");
    if (result.kind !== "detail" || !result.value) return;
    expect(result.value.playLines).toHaveLength(2);
    expect(result.value.playLines[0]?.episodes).toHaveLength(2);
    expect(result.value.playLines[1]?.episodes[0]?.url).toContain("movie.mp4");
  });

  it("normalizes iframe parser responses and rejects empty details", () => {
    const playback = normalizeCatVodResult(
      "parseIframe",
      {
        url: "https://example.com/play.m3u8",
        headers: { Referer: "https://example.com" },
      },
      context,
    );
    const emptyDetail = normalizeCatVodResult(
      "getDetail",
      { message: "empty" },
      context,
    );

    expect(playback).toEqual({
      kind: "playback",
      value: {
        url: "https://example.com/play.m3u8",
        headers: { Referer: "https://example.com" },
      },
    });
    expect(emptyDetail).toEqual({ kind: "detail", value: null });
  });
});
