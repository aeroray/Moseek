import { describe, expect, it } from "vitest";

import { favoriteKey, isFavoriteItem } from "@/lib/favorite-key";
import type { VodFavorite, VodItem } from "@/types/moseek";

function favorite(sourceKey: string, id: string): VodFavorite {
  return {
    key: favoriteKey({ id, sourceKey }),
    item: { id, sourceKey } as VodItem,
    sourceKey,
    sourceName: sourceKey,
    savedAt: "2026-01-01T00:00:00.000Z",
    progress: null,
  };
}

describe("favourite identity", () => {
  it("keys by source as well as id, because ids are only unique within a source", () => {
    // Two sources can both publish a `vod-1`. Keying by id alone would make them the same work.
    expect(favoriteKey({ id: "vod-1", sourceKey: "cms-a" })).toBe("cms-a:vod-1");
    expect(favoriteKey({ id: "vod-1", sourceKey: "cms-b" })).not.toBe(
      favoriteKey({ id: "vod-1", sourceKey: "cms-a" }),
    );
  });

  it("does not report another source's work as favourited", () => {
    // This was a real bug: the heart compared by id alone, so a same-id work from a different
    // source showed as favourited — and pressing it could not turn the mark off, because the
    // store was toggling a different key.
    const favorites = [favorite("cms-a", "vod-1")];

    expect(isFavoriteItem(favorites, { id: "vod-1", sourceKey: "cms-a" })).toBe(true);
    expect(isFavoriteItem(favorites, { id: "vod-1", sourceKey: "cms-b" })).toBe(false);
  });

  it("treats an empty list as nothing favourited", () => {
    expect(isFavoriteItem([], { id: "vod-1", sourceKey: "cms-a" })).toBe(false);
  });
});
