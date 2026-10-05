import { describe, expect, it } from "vitest";

import {
  attachExportExtras,
  readExportExtras,
} from "@/features/config/config-extras";
import type { LiveFavorite, VodFavorite } from "@/types/moseek";

const favorite = (key: string): VodFavorite =>
  ({
    key,
    item: { id: key, name: `作品 ${key}` },
    sourceKey: "src",
    sourceName: "源",
    savedAt: "2026-01-01T00:00:00.000Z",
    progress: null,
  }) as unknown as VodFavorite;

const liveFavorite = (key: string): LiveFavorite =>
  ({
    key,
    channel: { id: key, name: `频道 ${key}` },
    sourceKey: "live",
    sourceName: "直播源",
    savedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as LiveFavorite;

const CONFIG = JSON.stringify({ sites: [{ key: "a", api: "https://a" }], lives: [] });

describe("attachExportExtras", () => {
  it("adds favourites and the theme without disturbing the configuration", () => {
    const text = attachExportExtras(CONFIG, {
      schemaVersion: 1,
      theme: "dark",
      favorites: [favorite("a")],
      liveFavorites: [liveFavorite("c")],
    });
    const parsed = JSON.parse(text);

    // The configuration itself is what other clients read; it must survive byte-for-byte in meaning.
    expect(parsed.sites).toEqual([{ key: "a", api: "https://a" }]);
    expect(parsed.lives).toEqual([]);
    expect(parsed.moseek.theme).toBe("dark");
    expect(parsed.moseek.favorites).toHaveLength(1);
    expect(parsed.moseek.liveFavorites).toHaveLength(1);
  });

  it("never writes 足迹", () => {
    // The user asked for it to stay out: it records where this machine has been, and carrying it to
    // another computer would be noise. A stray key would also make the file's shape unpredictable.
    const text = attachExportExtras(CONFIG, { schemaVersion: 1, theme: "dark" });
    expect(text).not.toContain("history");
    expect(text).not.toContain("足迹");
  });

  it("omits empty collections rather than writing empty arrays", () => {
    // An absent key and an empty one mean the same thing to the importer, and a file that says
    // nothing about favourites should not look like it is saying "you have none".
    const parsed = JSON.parse(
      attachExportExtras(CONFIG, { schemaVersion: 1, favorites: [], liveFavorites: [] }),
    );
    expect(parsed.moseek).not.toHaveProperty("favorites");
    expect(parsed.moseek).not.toHaveProperty("liveFavorites");
  });

  it("returns unparseable text unchanged", () => {
    // An export that cannot be annotated is still a valid export; refusing to write it would be the
    // worse outcome.
    expect(attachExportExtras("not json", { schemaVersion: 1, theme: "dark" })).toBe("not json");
  });
});

describe("readExportExtras", () => {
  it("round-trips what an export wrote", () => {
    const text = attachExportExtras(CONFIG, {
      schemaVersion: 1,
      theme: "light",
      favorites: [favorite("a")],
      liveFavorites: [liveFavorite("c")],
    });
    const extras = readExportExtras(text);

    expect(extras?.theme).toBe("light");
    expect(extras?.favorites?.[0].key).toBe("a");
    expect(extras?.liveFavorites?.[0].key).toBe("c");
  });

  it("returns null for a configuration written by someone else", () => {
    // The ordinary case: a TVBox file has no `moseek` key. Import must not treat that as "the user
    // has no favourites" and clear what is there.
    expect(readExportExtras(CONFIG)).toBeNull();
  });

  it("keeps an absent collection distinct from an empty one", () => {
    // `undefined` means "the file said nothing about favourites"; `[]` would mean "you have none".
    // The store relies on the difference to decide whether to touch the list at all.
    const extras = readExportExtras(
      JSON.stringify({ sites: [], moseek: { schemaVersion: 1, theme: "dark" } }),
    );
    expect(extras?.favorites).toBeUndefined();
    expect(extras?.liveFavorites).toBeUndefined();
  });

  it("drops entries that are not the shape the store expects", () => {
    // This text may have come from a URL the user pasted. A malformed entry must not be able to put
    // the store into a state the rest of the app assumes cannot happen.
    const extras = readExportExtras(
      JSON.stringify({
        sites: [],
        moseek: {
          schemaVersion: 1,
          favorites: [{ key: "good", item: {} }, { key: 42 }, null, "nope"],
          liveFavorites: [{ key: "ok", channel: {} }, { channel: {} }],
        },
      }),
    );

    expect(extras?.favorites).toHaveLength(1);
    expect(extras?.favorites?.[0].key).toBe("good");
    expect(extras?.liveFavorites).toHaveLength(1);
    expect(extras?.liveFavorites?.[0].key).toBe("ok");
  });

  it("ignores a theme it does not recognise", () => {
    const extras = readExportExtras(
      JSON.stringify({ sites: [], moseek: { schemaVersion: 1, theme: "neon" } }),
    );
    expect(extras?.theme).toBeUndefined();
  });

  it("returns null for text that is not an object", () => {
    expect(readExportExtras("[]")).toBeNull();
    expect(readExportExtras("not json")).toBeNull();
    expect(readExportExtras("null")).toBeNull();
  });
});
