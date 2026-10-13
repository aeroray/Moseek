import { describe, expect, it } from "vitest";

import {
  APP_DATA_KIND,
  buildAppDataText,
  readAppDataText,
} from "@/features/settings/app-data-file";
import type { LiveFavorite, VodFavorite } from "@/types/moseek";

const favorite = (key: string): VodFavorite =>
  ({
    key,
    item: {
      id: key,
      sourceKey: "src",
      sourceName: "源",
      name: `作品 ${key}`,
      poster: "",
      description: "",
      year: "",
      area: "",
      categories: [],
      actors: [],
      directors: [],
      playLines: [],
    },
    sourceKey: "src",
    sourceName: "源",
    savedAt: "2026-01-01T00:00:00.000Z",
    progress: null,
  }) as VodFavorite;

const liveFavorite = (key: string): LiveFavorite =>
  ({
    key,
    channel: {
      id: key,
      name: `频道 ${key}`,
      groupId: "g",
      groupName: "默认",
      logoUrl: "",
      streamUrl: "https://live.example/a.m3u8",
      streamUrls: ["https://live.example/a.m3u8"],
      mediaKind: "hls",
      sourceKey: "live",
    },
    sourceKey: "live",
    sourceName: "直播源",
    savedAt: "2026-01-01T00:00:00.000Z",
  }) as LiveFavorite;

/**
 * 软件数据 — the app's own file, separate from the configuration.
 *
 * The user's stated rule is the design here: 配置中心 carries resources, 设置 carries app data. These
 * two used to be one file, which made 收藏 appear under 其他设置 as though it were a TVBox setting.
 */
describe("buildAppDataText", () => {
  it("marks the file so an import can tell it from a configuration", () => {
    // Both files are JSON objects and both sit in the user's downloads folder. Without the marker, a
    // configuration would be read as a data file and restore nothing while appearing to succeed.
    const parsed = JSON.parse(buildAppDataText({ theme: "dark" }));
    expect(parsed.kind).toBe(APP_DATA_KIND);
  });

  it("omits empty collections rather than writing empty arrays", () => {
    // An absent key means "the file says nothing about favourites". `[]` would mean "you have none",
    // and the store relies on the difference to decide whether to touch the list.
    const parsed = JSON.parse(buildAppDataText({ theme: "dark", favorites: [], liveFavorites: [] }));
    expect(parsed).not.toHaveProperty("favorites");
    expect(parsed).not.toHaveProperty("liveFavorites");
  });

  it("writes favourites and the theme", () => {
    const parsed = JSON.parse(
      buildAppDataText({
        theme: "light",
        favorites: [favorite("a")],
        liveFavorites: [liveFavorite("c")],
      }),
    );
    expect(parsed.theme).toBe("light");
    expect(parsed.favorites).toHaveLength(1);
    expect(parsed.liveFavorites).toHaveLength(1);
  });

  it("never writes 足迹", () => {
    // The user asked for it to stay out: a list of where you have been is a record of this machine's
    // use, and carrying it to another computer would be noise at best.
    const text = buildAppDataText({ theme: "dark", favorites: [favorite("a")] });
    expect(text).not.toContain("history");
    expect(text).not.toContain("足迹");
  });
});

describe("readAppDataText", () => {
  it("round-trips its own file", () => {
    const text = buildAppDataText({
      theme: "light",
      favorites: [favorite("a")],
      liveFavorites: [liveFavorite("c")],
    });
    const data = readAppDataText(text);

    expect(data?.theme).toBe("light");
    expect(data?.favorites?.[0]?.key).toBe("a");
    expect(data?.liveFavorites?.[0]?.key).toBe("c");
  });

  it("still reads the old shape, where the data lived inside a configuration", () => {
    // **A user who exported before the split has their only copy in that form.** Refusing it would be
    // true — it is a configuration, not a data file — and would lose their favourites.
    const legacy = JSON.stringify({
      sites: [{ key: "a", api: "https://a.example/api" }],
      lives: [],
      moseek: {
        schemaVersion: 1,
        theme: "dark",
        favorites: [favorite("legacy")],
      },
    });
    const data = readAppDataText(legacy);

    expect(data?.theme).toBe("dark");
    expect(data?.favorites?.[0]?.key).toBe("legacy");
  });

  it("returns null for a plain configuration with no data in it", () => {
    // The common case: a TVBox file. The caller must be able to say which file was expected rather
    // than reporting a successful import that restored nothing.
    expect(readAppDataText(JSON.stringify({ sites: [], lives: [] }))).toBeNull();
  });

  it("returns null for text that is not an object", () => {
    expect(readAppDataText("not json")).toBeNull();
    expect(readAppDataText("[]")).toBeNull();
    expect(readAppDataText("null")).toBeNull();
  });

  it("drops entries the store cannot use", () => {
    // This file may have been edited or come from elsewhere; a malformed entry must not put the store
    // into a state the rest of the app assumes cannot happen.
    const data = readAppDataText(
      JSON.stringify({
        kind: APP_DATA_KIND,
        schemaVersion: 1,
        favorites: [favorite("good"), { key: "bad" }, null, "nope"],
      }),
    );
    expect(data?.favorites).toHaveLength(1);
    expect(data?.favorites?.[0]?.key).toBe("good");
  });

  it("ignores a theme it does not recognise", () => {
    const data = readAppDataText(
      JSON.stringify({ kind: APP_DATA_KIND, schemaVersion: 1, theme: "neon" }),
    );
    expect(data?.theme).toBeUndefined();
  });
});
