import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "@/stores/app-store";
import type { LiveFavorite, VodFavorite } from "@/types/moseek";

/**
 * Restoring the favourites an imported configuration carries.
 *
 * The behaviour that matters is that this **merges** rather than replaces. Favourites are the one
 * collection a user cannot reconstruct — sources can be re-imported from a URL, but a curated list
 * cannot — so an import that cleared them would be a data-loss bug wearing the clothes of a feature.
 */

function vodFavorite(key: string, savedAt = "2026-01-01T00:00:00.000Z"): VodFavorite {
  return {
    key,
    item: { id: key, name: `作品 ${key}` } as VodFavorite["item"],
    sourceKey: "src",
    sourceName: "源",
    savedAt,
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

describe("restoreFavorites", () => {
  beforeEach(() => {
    useAppStore.setState({ favorites: [], liveFavorites: [] });
  });

  it("adds what the file carried", () => {
    const added = useAppStore.getState().restoreFavorites({
      favorites: [vodFavorite("a"), vodFavorite("b")],
      liveFavorites: [liveFavorite("c")],
    });

    expect(added).toEqual({ vod: 2, live: 1 });
    expect(useAppStore.getState().favorites.map((f) => f.key)).toEqual(["a", "b"]);
    expect(useAppStore.getState().liveFavorites.map((f) => f.key)).toEqual(["c"]);
  });

  it("keeps what was already there instead of replacing it", () => {
    // The whole point. Replacing would destroy a collection the user cannot rebuild from a URL.
    useAppStore.setState({ favorites: [vodFavorite("existing")] });

    useAppStore.getState().restoreFavorites({ favorites: [vodFavorite("imported")] });

    expect(useAppStore.getState().favorites.map((f) => f.key)).toEqual([
      "existing",
      "imported",
    ]);
  });

  it("does not overwrite the local copy of a favourite it already has", () => {
    // Progress lives on the local entry. The travelling copy has none, so letting it win would
    // silently reset how far the user had watched.
    useAppStore.setState({
      favorites: [
        {
          ...vodFavorite("same"),
          progress: {
            lineId: "line-1",
            episodeId: "ep-1",
            episodeName: "第 1 集",
            seconds: 120,
            episodeCount: 24,
            updatedAt: "2026-02-02T00:00:00.000Z",
          },
        },
      ],
    });

    const added = useAppStore.getState().restoreFavorites({
      favorites: [vodFavorite("same")],
    });

    expect(added).toEqual({ vod: 0, live: 0 });
    expect(useAppStore.getState().favorites[0].progress?.seconds).toBe(120);
  });

  it("touches nothing when the file said nothing about favourites", () => {
    // A configuration written by someone else has no extras at all. `undefined` means "no opinion",
    // which must not be read as "you have none".
    useAppStore.setState({ favorites: [vodFavorite("mine")] });

    const added = useAppStore.getState().restoreFavorites({});

    expect(added).toEqual({ vod: 0, live: 0 });
    expect(useAppStore.getState().favorites.map((f) => f.key)).toEqual(["mine"]);
  });

  it("appends rather than prepends, so the list keeps its newest-first order", () => {
    // The list is ordered newest-first, and an imported favourite was not saved now. Putting it on
    // top would reorder a user's collection to match the contents of a file.
    useAppStore.setState({ favorites: [vodFavorite("newest")] });

    useAppStore.getState().restoreFavorites({ favorites: [vodFavorite("old")] });

    expect(useAppStore.getState().favorites.map((f) => f.key)).toEqual(["newest", "old"]);
  });

  it("counts only what it actually added", () => {
    // The caller reports this number to the user, so counting a duplicate would make the app claim
    // it restored something it skipped.
    useAppStore.setState({ favorites: [vodFavorite("dup")] });

    const added = useAppStore.getState().restoreFavorites({
      favorites: [vodFavorite("dup"), vodFavorite("fresh")],
    });

    expect(added).toEqual({ vod: 1, live: 0 });
  });
});
