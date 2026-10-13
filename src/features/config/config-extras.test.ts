import { describe, expect, it } from "vitest";

import {
  EXPORT_EXTRAS_KEY,
  readExportExtras,
  stripExportExtras,
  type MoseekExportExtras,
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

/**
 * Builds the legacy shape the old exporter wrote.
 *
 * Kept as a local helper now that nothing in the application writes it — `attachExportExtras` was
 * removed when 软件数据 moved to 设置. The reader and the stripper still have to understand the shape,
 * because a user who exported before the split has their only copy in it.
 */
function withExtras(configText: string, extras: MoseekExportExtras): string {
  const parsed = JSON.parse(configText);
  const cleaned: MoseekExportExtras = { schemaVersion: 1 };
  if (extras.theme) cleaned.theme = extras.theme;
  if (extras.favorites?.length) cleaned.favorites = extras.favorites;
  if (extras.liveFavorites?.length) cleaned.liveFavorites = extras.liveFavorites;
  return JSON.stringify({ ...parsed, [EXPORT_EXTRAS_KEY]: cleaned }, null, 2);
}

describe("stripExportExtras", () => {
  it("removes the app's own data from a configuration document", () => {
    // **The defect this exists for.** The key is this app's own data, not configuration, but the visual
    // editor lists unrecognised top-level keys under 其他设置 — so importing an exported file showed the
    // user's 收藏 inside a block described as "TVBox 客户端的设置". Reported by the user as confusing.
    const text = stripExportExtras(
      withExtras(CONFIG, {
        schemaVersion: 1,
        theme: "dark",
        favorites: [favorite("a")],
        liveFavorites: [liveFavorite("c")],
      }),
    );
    const parsed = JSON.parse(text);

    expect(parsed).not.toHaveProperty(EXPORT_EXTRAS_KEY);
    // The configuration itself must survive: this is a removal, not a rewrite.
    expect(parsed.sites).toEqual([{ key: "a", api: "https://a" }]);
    expect(parsed.lives).toEqual([]);
  });

  it("returns a configuration with no extras byte-for-byte unchanged", () => {
    // The ordinary case is a file written by another client, and re-serialising it would drop comments
    // and layout for no reason.
    expect(stripExportExtras(CONFIG)).toBe(CONFIG);
  });

  it("returns unparseable text unchanged rather than throwing", () => {
    // A document that cannot be read is not a reason to fail the import: the parser will report it.
    expect(stripExportExtras("not json")).toBe("not json");
    expect(stripExportExtras("[]")).toBe("[]");
    expect(stripExportExtras("null")).toBe("null");
  });

  it("does not touch a key that merely contains the word", () => {
    // Scoped to the exact key, so a configuration carrying `moseekVersion` or `notmoseek` keeps it.
    const text = stripExportExtras(
      JSON.stringify({ sites: [], moseekVersion: 2, nested: { [EXPORT_EXTRAS_KEY]: 1 } }),
    );
    const parsed = JSON.parse(text);
    expect(parsed.moseekVersion).toBe(2);
    expect(parsed.nested[EXPORT_EXTRAS_KEY]).toBe(1);
  });
});

describe("readExportExtras", () => {
  it("round-trips what the old exporter wrote", () => {
    // The reader is the one part of the old shape that must keep working: a user who exported before
    // 软件数据 moved has their only copy of their favourites in this form.
    const text = withExtras(CONFIG, {
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
          favorites: [favorite("good"), { key: "bad", item: {} }, { key: 42 }, null, "nope"],
          liveFavorites: [liveFavorite("ok"), { key: "bad", channel: {} }, { channel: {} }],
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
