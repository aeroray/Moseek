import { describe, expect, it } from "vitest";

import {
  episodeMediaKind,
  pickEntryEpisode,
  resumeSeconds,
} from "@/features/player/episode-playback";
import { normalizeTitle } from "@/features/browse/favorite-relink";
import type { VodItem } from "@/types/moseek";

function item(episodes: { id: string; name: string }[]): VodItem {
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
    playLines: [
      {
        id: "line-1",
        name: "线路一",
        episodes: episodes.map((episode) => ({
          ...episode,
          url: `https://cdn.example/${episode.id}.m3u8`,
        })),
      },
    ],
  };
}

const threeEpisodes = [
  { id: "ep-1", name: "第01集" },
  { id: "ep-2", name: "第02集" },
  { id: "ep-3", name: "第03集" },
];

describe("favourite entry episode", () => {
  it("starts at the first episode when the work was never watched", () => {
    // The user's rule: no progress means the beginning. "Latest" was rejected as the default
    // because a work nobody has opened starting at episode 40 of 40 is baffling.
    expect(pickEntryEpisode(item(threeEpisodes), null)).toEqual({
      lineId: "line-1",
      episodeId: "ep-1",
    });
  });

  it("resumes the saved episode when there is progress", () => {
    expect(
      pickEntryEpisode(item(threeEpisodes), {
        lineId: "line-1",
        episodeId: "ep-2",
        episodeName: "第02集",
      }),
    ).toEqual({ lineId: "line-1", episodeId: "ep-2" });
  });

  it("does not jump to the newest episode just because the series was updated", () => {
    // An updated series the user is part-way through must resume, not skip ahead.
    const updated = item([
      ...threeEpisodes,
      { id: "ep-4", name: "第04集" },
      { id: "ep-5", name: "第05集" },
    ]);
    expect(
      pickEntryEpisode(updated, {
        lineId: "line-1",
        episodeId: "ep-2",
        episodeName: "第02集",
      }).episodeId,
    ).toBe("ep-2");
  });

  it("keeps the user's place when the work was relinked to another source", () => {
    // A different source numbers and names episodes independently, so the ids do not survive.
    // The name is what carries the position across.
    expect(
      pickEntryEpisode(item(threeEpisodes), {
        lineId: "line-from-old-source",
        episodeId: "old-episode-id",
        episodeName: "第02集",
      }),
    ).toEqual({ lineId: "line-1", episodeId: "ep-2" });
  });

  it("falls back to the first episode when nothing matches at all", () => {
    expect(
      pickEntryEpisode(item(threeEpisodes), {
        lineId: "gone",
        episodeId: "gone",
        episodeName: "第99集",
      }),
    ).toEqual({ lineId: "line-1", episodeId: "ep-1" });
  });
});

describe("resume position", () => {
  it("ignores a position too close to the start to be worth seeking to", () => {
    // Seeking a couple of seconds in can make some players stall rather than simply begin.
    expect(resumeSeconds({ seconds: 3 })).toBe(0);
    expect(resumeSeconds(null)).toBe(0);
  });

  it("returns a position worth resuming", () => {
    expect(resumeSeconds({ seconds: 620 })).toBe(620);
  });
});

describe("relink title matching", () => {
  it("treats decorated versions of the same title as equal", () => {
    // Sources decorate names inconsistently, so a literal comparison misses the same work.
    const canonical = normalizeTitle("庆余年");
    expect(normalizeTitle("庆余年[完结]")).toBe(canonical);
    expect(normalizeTitle("庆余年（高清）")).toBe(canonical);
    expect(normalizeTitle("庆余年 全集")).toBe(canonical);
    expect(normalizeTitle("庆余年 HD")).toBe(canonical);
  });

  it("keeps genuinely different works apart", () => {
    // A loose match would play the *wrong* work, which is worse than finding nothing.
    expect(normalizeTitle("庆余年")).not.toBe(normalizeTitle("庆余年第二季"));
    expect(normalizeTitle("英雄")).not.toBe(normalizeTitle("英雄本色"));
  });
});

describe("episode media kind", () => {
  it("infers from the URL and admits when it cannot tell", () => {
    expect(episodeMediaKind({ id: "1", name: "a", url: "https://x/a.m3u8" })).toBe(
      "hls",
    );
    expect(episodeMediaKind({ id: "1", name: "a", url: "https://x/a.mp4" })).toBe(
      "mp4",
    );
    expect(episodeMediaKind({ id: "1", name: "a", url: "https://x/opaque" })).toBe(
      "unknown",
    );
    expect(episodeMediaKind(undefined)).toBe("unknown");
  });
});
