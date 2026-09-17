import { searchVod } from "@/features/browse/cms-adapter";
import { isMovieLibrarySource } from "@/lib/adapters";
import type { SourceRecord, VodItem } from "@/types/moseek";

export interface RelinkResult {
  item: VodItem;
  source: SourceRecord;
}

/**
 * Finds the same work in another enabled source.
 *
 * A favourite outlives the source it came from: sources get deleted, renamed, or simply stop
 * answering. The snapshot keeps the work playable for a while, but an address that has gone stale
 * needs a replacement, and asking the user to go and find it again defeats the point of
 * favouriting it.
 *
 * The match is deliberately strict — the name must agree once normalised — because the failure
 * mode of a loose match is playing the *wrong* work, which is far worse than reporting that
 * nothing was found. Titles carry decorations that differ between sources (`[完结]`, `HD`,
 * full-width punctuation), so those are stripped before comparing.
 *
 * The original source is skipped: its snapshot already failed, so asking it again would only
 * repeat the failure.
 */
export async function relinkFavorite(
  item: VodItem,
  sources: SourceRecord[],
  originalSourceKey: string,
): Promise<RelinkResult | null> {
  const target = normalizeTitle(item.name);
  if (!target) return null;

  const candidates = sources.filter(
    (source) =>
      source.key !== originalSourceKey && isMovieLibrarySource(source),
  );

  for (const source of candidates) {
    const result = await searchVod(source, item.name, "all", 1, 10).catch(
      () => null,
    );
    if (!result?.data) continue;
    const match = result.data.items.find(
      (candidate) => normalizeTitle(candidate.name) === target,
    );
    if (match) return { item: match, source };
  }

  return null;
}

/**
 * Reduces a title to what actually identifies it.
 *
 * Sources decorate names inconsistently — `[完结]`, `(国语)`, `HD`, `全集`, full-width brackets
 * and spaces — so a literal comparison misses the same work listed twice. Only decorations are
 * removed: the year and the actual title words are kept, because dropping them would make two
 * genuinely different works compare equal.
 */
export function normalizeTitle(name: string): string {
  return name
    .replace(/[（(【[][^）)】\]]*[）)】\]]/g, "")
    .replace(
      /(完结|全集|国语|粤语|高清|超清|蓝光|抢先版|正式版|HD|BD|TS|TC|4K|1080P|720P)/gi,
      "",
    )
    .replace(/[\s·・\-—_.,，。:：!！?？'"“”‘’]/g, "")
    .toLowerCase();
}
