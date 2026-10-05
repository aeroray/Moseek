import type { LiveFavorite, ThemeMode, VodFavorite } from "@/types/moseek";

/**
 * The part of an export that is not configuration.
 *
 * A TVBox configuration has no notion of favourites or of a UI theme, so these travel in a
 * namespaced `moseek` key alongside the real fields. Two consequences follow, and both are why the
 * shape is defined here rather than inline at the call site:
 *
 *  - **The file stays importable by other clients.** `sites` / `lives` / `parses` are untouched, so
 *    TVBox and friends read the same file they always could; the extra key is ignored by them.
 *  - **Import has to opt in.** Reading `moseek` back is a deliberate step, not a side effect of
 *    parsing, so a configuration from an untrusted source cannot silently replace the user's
 *    favourites or their theme.
 *
 * 足迹 is deliberately absent. The user asked for it to stay out: a list of where you have been is a
 * record of this machine's use, and carrying it to another computer would be noise at best.
 */
export interface MoseekExportExtras {
  schemaVersion: 1;
  /** The UI theme, so a new machine opens looking the way this one did. */
  theme?: ThemeMode;
  favorites?: VodFavorite[];
  liveFavorites?: LiveFavorite[];
}

/** The key these extras live under in an exported file. */
export const EXPORT_EXTRAS_KEY = "moseek";

/**
 * Merges the extras into a configuration document.
 *
 * Operates on text rather than on an object because the raw text is what the app stores and exports:
 * parsing and re-serialising it here would drop any field the parser does not model — the same
 * reason the import merge works on raw text.
 *
 * If the text is not a JSON object, it is returned unchanged. An export that cannot be annotated is
 * still a valid export; refusing to write it would be the worse outcome.
 */
export function attachExportExtras(
  configText: string,
  extras: MoseekExportExtras,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return configText;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return configText;
  }

  // Drop empty collections rather than writing `"favorites": []`: an absent key and an empty one mean
  // the same thing to the importer, and a file that says nothing about favourites should not look
  // like it is saying "you have none".
  const cleaned: MoseekExportExtras = { schemaVersion: 1 };
  if (extras.theme) cleaned.theme = extras.theme;
  if (extras.favorites?.length) cleaned.favorites = extras.favorites;
  if (extras.liveFavorites?.length) cleaned.liveFavorites = extras.liveFavorites;

  return JSON.stringify({ ...parsed, [EXPORT_EXTRAS_KEY]: cleaned }, null, 2);
}

/**
 * Reads the extras back out of a configuration document.
 *
 * Returns `null` when the document carries none, which is the ordinary case for a configuration
 * written by someone else. Every field is validated before it is trusted: this text may have come
 * from a URL the user pasted, and a malformed entry must not be able to put the store into a state
 * the rest of the app assumes cannot happen.
 */
export function readExportExtras(configText: string): MoseekExportExtras | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const raw = (parsed as Record<string, unknown>)[EXPORT_EXTRAS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const extras: MoseekExportExtras = { schemaVersion: 1 };

  if (source.theme === "light" || source.theme === "dark" || source.theme === "system") {
    extras.theme = source.theme;
  }
  const favorites = sanitizeList<VodFavorite>(source.favorites, (entry) =>
    Boolean(entry && typeof entry.key === "string" && entry.item && typeof entry.item === "object"),
  );
  if (favorites) extras.favorites = favorites;

  const liveFavorites = sanitizeList<LiveFavorite>(source.liveFavorites, (entry) =>
    Boolean(entry && typeof entry.key === "string" && entry.channel && typeof entry.channel === "object"),
  );
  if (liveFavorites) extras.liveFavorites = liveFavorites;

  return extras;
}

/**
 * Keeps only the entries that pass `isValid`, or returns `undefined` when the value is not a list.
 *
 * `undefined` and `[]` are kept distinct on purpose: the caller uses the difference to decide whether
 * the file said anything about that collection at all, and an empty list would otherwise be read as
 * "the user has none" and could clear what is already there.
 */
function sanitizeList<T>(
  value: unknown,
  isValid: (entry: T) => boolean,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is T => isValid(entry as T));
}
