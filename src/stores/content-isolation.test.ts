import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { isFavoriteItem } from "@/lib/favorite-key";
import type { VodItem } from "@/types/moseek";

const item = (sourceKey: string): VodItem => ({
  id: "1", sourceKey, sourceName: sourceKey, name: "作品", poster: "", description: "", year: "", area: "",
  categories: [], actors: [], directors: [], playLines: [],
});

describe("source isolation for user content", () => {
  beforeEach(() => useAppStore.setState({ history: [], favorites: [], liveFavorites: [], playbackProgress: {} }));

  it("keeps identical work and episode ids from different sources independent", () => {
    for (const key of ["a", "b"]) {
      useAppStore.getState().addVodFootprint({ item: item(key), lineId: "line", episodeId: "ep", episodeName: "第一集", progress: 0 });
    }
    expect(useAppStore.getState().history.map((record) => record.id)).toEqual(["b:1:ep", "a:1:ep"]);
    useAppStore.getState().setPlaybackProgress("a:1:ep", 120);
    expect(useAppStore.getState().history.map((record) => record.kind === "vod" ? record.progress : -1)).toEqual([0, 120]);
  });

  it("writes progress only to the selected favourite", () => {
    useAppStore.getState().toggleFavorite(item("a"));
    useAppStore.getState().toggleFavorite(item("b"));
    useAppStore.getState().setFavoriteProgress("a:1", { lineId: "line", episodeId: "ep", episodeName: "第一集", seconds: 120, episodeCount: 1, updatedAt: "now" });
    expect(useAppStore.getState().favorites.find((favorite) => favorite.key === "a:1")?.progress?.seconds).toBe(120);
    expect(useAppStore.getState().favorites.find((favorite) => favorite.key === "b:1")?.progress).toBeNull();
  });

  it("deduplicates multiple copies within one imported collection", () => {
    useAppStore.getState().toggleFavorite(item("a"));
    const favorite = useAppStore.getState().favorites[0];
    useAppStore.setState({ favorites: [] });
    expect(useAppStore.getState().restoreFavorites({ favorites: [favorite, favorite] })).toEqual({ vod: 1, live: 0 });
    expect(useAppStore.getState().favorites).toHaveLength(1);
  });

  it("can remove a relinked favourite whose snapshot now belongs to another source", () => {
    useAppStore.getState().toggleFavorite(item("a"));
    useAppStore.getState().refreshFavorite("a:1", item("b"));
    expect(isFavoriteItem(useAppStore.getState().favorites, item("b"))).toBe(true);
    useAppStore.getState().toggleFavorite(item("b"));
    expect(useAppStore.getState().favorites).toEqual([]);
  });
});
