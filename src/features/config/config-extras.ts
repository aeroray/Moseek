import type { LiveFavorite, ThemeMode, VodFavorite } from "@/types/moseek";
import { normalizeLiveFavorite, normalizeVodFavorite } from "@/lib/user-content";

/**
 * The part of a file that is not configuration, and the one reader that still understands it.
 *
 * **This is now a legacy shape, kept deliberately.** Favourites and the theme used to be written into
 * every exported configuration under a `moseek` key. That was wrong for two reasons the user reported:
 * the visual editor renders unrecognised top-level keys as rows under 其他设置, so importing an export
 * showed 收藏 as a TVBox client setting; and exporting a configuration carried personal data with it.
 *
 * They now live in their own file — see `features/settings/app-data-file.ts` — and `sites` / `lives` /
 * `parses` are the only keys a configuration carries.
 *
 * What remains here is the reader, because a user who exported before the split has their only copy of
 * their favourites in this shape, and refusing to read it would lose it. `stripExportExtras` is what
 * keeps the shape out of the stored document.
 *
 * 足迹 is deliberately absent from all of it. The user asked for it to stay out: a list of where you
 * have been is a record of this machine's use, and carrying it to another computer would be noise.
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
 * Removes the `moseek` key from a configuration document.
 *
 * **A configuration that still carries it shows the user's own app data as a configuration setting.**
 * The visual editor lists unrecognised top-level keys under 其他设置, and `moseek` was not in its known
 * set, so importing an exported file put 收藏 and the theme into a block labelled "TVBox 客户端的设置".
 *
 * Stripping at the import boundary is what keeps the stored document a pure configuration. Doing it on
 * export alone would leave the key in every document already imported, so the block would return on the
 * next open — the stored text, not the file, is what the editor reads.
 *
 * Returns the text unchanged when the key is absent, so the ordinary case costs one parse and no
 * re-serialisation: comments and layout survive for a configuration written by another client.
 */
export function stripExportExtras(configText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return configText;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return configText;
  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, EXPORT_EXTRAS_KEY)) return configText;
  delete record[EXPORT_EXTRAS_KEY];
  return JSON.stringify(record, null, 2);
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
  const favorites = sanitizeList(source.favorites, normalizeVodFavorite);
  if (favorites) extras.favorites = favorites;

  const liveFavorites = sanitizeList(source.liveFavorites, normalizeLiveFavorite);
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
  normalize: (entry: unknown) => T | null,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(normalize).filter((entry): entry is T => entry !== null);
}
