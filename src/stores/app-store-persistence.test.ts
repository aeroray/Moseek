import { describe, expect, it } from "vitest";

import {
  migrateActiveView,
  migratePlaybackProgress,
  migrateTheme,
  useAppStore,
  VIEW_KEYS,
} from "@/stores/app-store";
import type { FootprintRecord, LiveFavorite, VodFavorite } from "@/types/moseek";

/**
 * What survives a restart, and what is allowed not to.
 *
 * The store persists a mixture of two different things, and they must not be treated alike:
 *
 *  - A **mirror** of SQLite (`sources`, `rawConfig`, `normalizedConfig`). `App` reloads these from the
 *    backend on every launch, so a persisted copy that does not describe an import is stale and
 *    dropping it is correct.
 *  - The **user's own content** (`favorites`, `history`, `liveFavorites`, `playbackProgress`). These
 *    live only here — measured, the Rust tables `favorites` and `play_history` exist but no command
 *    reads or writes them — so anything dropped is gone for good.
 *
 * The `merge` below used to gate both on "was a configuration imported", which discarded the second
 * group on any install that had none. These tests pin the distinction.
 */

function vodFavorite(key: string): VodFavorite {
  return {
    key,
    item: { id: key, name: `作品 ${key}` } as VodFavorite["item"],
    sourceKey: "src",
    sourceName: "源",
    savedAt: "2026-01-01T00:00:00.000Z",
    progress: null,
  };
}

function liveFavorite(key: string): LiveFavorite {
  return {
    key,
    channel: { id: key, name: `频道 ${key}` } as LiveFavorite["channel"],
    sourceKey: "live",
    sourceName: "直播源",
    savedAt: "2026-01-01T00:00:00.000Z",
  };
}

function vodFootprint(id: string): FootprintRecord {
  return {
    kind: "vod",
    id,
    item: { id, name: `作品 ${id}` } as never,
    sourceKey: "src",
    sourceName: "源",
    lineId: "line",
    lineName: "线路",
    episodeId: "ep",
    episodeName: "第 1 集",
    progressSeconds: 12,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as FootprintRecord;
}

/** Runs the store's own merge, the way the persist middleware does on rehydration. */
function merge(persisted: unknown) {
  const merge = useAppStore.persist.getOptions().merge;
  expect(merge, "the store must have a merge").toBeTruthy();
  return merge!(persisted, useAppStore.getState()) as unknown as Record<string, unknown>;
}

describe("the persisted store's merge", () => {
  it("keeps favourites and footprints even with no configuration imported", () => {
    // **The reported defect.** With no configuration, the merge answered `[]` for every collection, so
    // an install without one lost its favourites, its footprints and its saved positions on the next
    // launch — and there is nowhere to restore them from.
    const merged = merge({
      rawConfig: "",
      configDocuments: [],
      favorites: [vodFavorite("a")],
      liveFavorites: [liveFavorite("b")],
      history: [vodFootprint("h1")],
      playbackProgress: { h1: 120 },
    });

    expect(merged.favorites).toHaveLength(1);
    expect(merged.liveFavorites).toHaveLength(1);
    expect(merged.history).toHaveLength(1);
    expect(merged.playbackProgress).toEqual({ h1: 120 });
  });

  it("keeps them when there is no persisted state at all", () => {
    // A first launch: nothing stored, nothing to lose. The defaults must be empty rather than a crash.
    const merged = merge(undefined);

    expect(merged.favorites).toEqual([]);
    expect(merged.history).toEqual([]);
    expect(merged.liveFavorites).toEqual([]);
    expect(merged.playbackProgress).toEqual({});
  });

  it("still drops the stale mirror when no configuration was imported", () => {
    // The other half, and the reason the gate existed: `sources`/`rawConfig` are reloaded from SQLite
    // at startup, so a persisted copy describing no import is stale. Dropping it is correct; the
    // distinction from the collections above is the whole point.
    const merged = merge({
      rawConfig: "",
      configDocuments: [],
      sources: [{ key: "stale", name: "陈旧源", sourceType: "cms", api: "https://x" }],
    });

    expect(merged.sources).toEqual([]);
  });

  it("keeps the mirror when a configuration was imported", () => {
    const merged = merge({
      rawConfig: '{"sites":[]}',
      configDocuments: [],
      sources: [{ key: "real", name: "真实源", sourceType: "cms", api: "https://x" }],
    });

    expect(merged.sources).toHaveLength(1);
  });

  it("drops stored entries that are not the shape they claim to be", () => {
    // The migrations are the validation. A collection that is not an array — a string, a number, an
    // object from some other version — must not reach the UI, where every reader assumes a list.
    const merged = merge({
      favorites: "nonsense",
      liveFavorites: 42,
      history: null,
      playbackProgress: "nonsense",
    });

    expect(merged.favorites).toEqual([]);
    expect(merged.liveFavorites).toEqual([]);
    expect(merged.history).toEqual([]);
    expect(merged.playbackProgress).toEqual({});
  });

  it("survives a stored document field that is not a string", () => {
    // **A crash, not a wrong value.** The gate read `persisted?.rawConfig?.trim()`, and `?.` only
    // guards `null`/`undefined` — a number or object stored under that key threw
    // `trim is not a function` *inside `merge`*, which is the one place that cannot fail: it runs
    // during rehydration, so the store never finishes loading and the app starts with nothing.
    //
    // The mirror is written by this app, so the value should always be a string; "should" is what the
    // other migrations in this file exist to stop relying on, and this one was the exception.
    for (const rawConfig of [123, { nested: true }, [], true, null]) {
      const merged = merge({ rawConfig, favorites: [vodFavorite("kept")] });
      // The mirror is dropped (it does not describe an import), and the user's content is not.
      expect(merged.sources).toEqual([]);
      expect(merged.favorites).toHaveLength(1);
    }
  });

  it("survives a document list that is not an array", () => {
    // Same class as above: `.length` on a number is `undefined` rather than a throw, but on a plain
    // object it is also undefined while looking like a valid check — so the shape is asserted rather
    // than inferred.
    const merged = merge({ configDocuments: 42, favorites: [vodFavorite("kept")] });

    expect(merged.configDocuments).toEqual([]);
    expect(merged.favorites).toHaveLength(1);
  });
});

describe("migratePlaybackProgress", () => {
  it("keeps finite non-negative positions", () => {
    expect(migratePlaybackProgress({ a: 0, b: 12.5, c: 3600 })).toEqual({
      a: 0,
      b: 12.5,
      c: 3600,
    });
  });

  it("drops values that are not usable positions", () => {
    // These are read as numbers by arithmetic — `NaN%` on the progress bar, a resume that seeks
    // nowhere — and a value this app never writes is not one to guess at.
    expect(
      migratePlaybackProgress({
        good: 10,
        fromString: "30",
        fromNull: null,
        negative: -5,
        infinite: Number.POSITIVE_INFINITY,
        nan: Number.NaN,
        object: { seconds: 5 },
      }),
    ).toEqual({ good: 10 });
  });

  it("returns an empty map for anything that is not a plain object", () => {
    expect(migratePlaybackProgress(undefined)).toEqual({});
    expect(migratePlaybackProgress(null)).toEqual({});
    expect(migratePlaybackProgress([1, 2])).toEqual({});
    expect(migratePlaybackProgress("nonsense")).toEqual({});
  });
});

describe("migrateActiveView", () => {
  it("maps the old name for the library to its current one", () => {
    // This view was called `home` before the library-first rename, and mapping it preserves where the
    // user actually was rather than sending them to the default.
    expect(migrateActiveView("home")).toBe("browse");
  });

  it("passes through every view it knows", () => {
    for (const key of VIEW_KEYS) {
      expect(migrateActiveView(key)).toBe(key);
    }
  });

  it("falls back rather than leaving the workspace empty", () => {
    // **An unrecognised value renders a blank window.** `App` mounts a pane only for a key it knows, so
    // an unknown one makes every condition false while the navigation bar still looks functional.
    expect(migrateActiveView("nonsense")).toBe("browse");
    expect(migrateActiveView(undefined)).toBe("browse");
    expect(migrateActiveView(null)).toBe("browse");
    expect(migrateActiveView(7)).toBe("browse");
  });

  it("is applied by the merge rather than left to the spread", () => {
    // Asserted through `merge`, not only on the function above: the function being correct does not
    // make it reachable, and a spread that overwrites the validated value afterwards looks identical
    // from the outside. The first version of this suite had that gap — it tested the helper only, and
    // deleting the call from the merge did not fail anything.
    expect(merge({ activeView: "nonsense" }).activeView).toBe("browse");
    expect(merge({ activeView: "home" }).activeView).toBe("browse");
    expect(merge({ activeView: "live" }).activeView).toBe("live");
  });
});

describe("migrateTheme", () => {
  it("passes through the three themes it knows", () => {
    expect(migrateTheme("light")).toBe("light");
    expect(migrateTheme("dark")).toBe("dark");
    expect(migrateTheme("system")).toBe("system");
  });

  it("falls back to system rather than a theme the UI cannot show", () => {
    // An unrecognised value renders light for ever while the settings dropdown shows no selection:
    // `App` toggles the `dark` class for `dark` and `system` only.
    expect(migrateTheme("neon")).toBe("system");
    expect(migrateTheme(undefined)).toBe("system");
    expect(migrateTheme(null)).toBe("system");
    expect(migrateTheme(1)).toBe("system");
  });

  it("is applied by the merge rather than left to the spread", () => {
    expect(merge({ theme: "neon" }).theme).toBe("system");
    expect(merge({ theme: "dark" }).theme).toBe("dark");
  });
});

describe("VIEW_KEYS agreement", () => {
  it("keeps the runtime list and the ViewKey type in step", () => {
    // Separated from the migrateActiveView block so the two cannot be confused when reading a failure:
    // this one is about the list drifting, that one is about the fallback behaviour.
    expect([...VIEW_KEYS].sort()).toEqual(
      ["browse", "live", "favorites", "history", "config", "settings"].sort(),
    );
  });
});
