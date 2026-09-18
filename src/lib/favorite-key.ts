import type { VodFavorite, VodItem } from "@/types/moseek";

/**
 * The key a favourite is stored under.
 *
 * Item ids are only unique within a source — two sources can both publish a `vod-1` — so the
 * source has to be part of the key. This is exported and used everywhere a favourite is looked
 * up, because the one place that compared by id alone reported a work as favourited when the
 * favourite actually belonged to a different source, and the heart could not be turned off.
 */
export function favoriteKey(item: Pick<VodItem, "id" | "sourceKey">): string {
  return `${item.sourceKey}:${item.id}`;
}

/** Whether this exact work, from this exact source, is favourited. */
export function isFavoriteItem(
  favorites: VodFavorite[],
  item: Pick<VodItem, "id" | "sourceKey">,
): boolean {
  const key = favoriteKey(item);
  return favorites.some((favorite) => favorite.key === key);
}
