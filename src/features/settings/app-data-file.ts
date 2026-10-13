import {
  EXPORT_EXTRAS_KEY,
  readExportExtras,
  type MoseekExportExtras,
} from "@/features/config/config-extras";
import { normalizeLiveFavorite, normalizeVodFavorite } from "@/lib/user-content";
import type { LiveFavorite, ThemeMode, VodFavorite } from "@/types/moseek";

/**
 * Software data as its own file: favourites and the theme.
 *
 * **Why this is separate from the configuration.** The configuration centre exports resources — the
 * sources a TVBox client reads. Favourites and the theme are this application's own data and mean
 * nothing to any other client. They used to ride along inside the configuration under a `moseek` key,
 * which had two visible consequences the user reported:
 *
 *  - The visual editor renders unrecognised top-level keys as rows under 其他设置, so importing an
 *    exported file showed the user's 收藏 in a block described as "TVBox 客户端的设置".
 *  - Exporting a configuration and importing it elsewhere silently carried personal data with it.
 *
 * The rule the user stated is the one implemented here: 配置中心 carries resources, 设置 carries app
 * data. Both files are JSON and both are written through the same Rust save dialog.
 */
export interface AppDataFile {
  /** A marker proving this file is Moseek's own data and not a configuration. */
  kind: "moseek-data";
  schemaVersion: 1;
  theme?: ThemeMode;
  favorites?: VodFavorite[];
  liveFavorites?: LiveFavorite[];
}

/**
 * The value that identifies a data file.
 *
 * Checked on import so a configuration file is rejected with a clear message rather than restoring
 * nothing and appearing to succeed. Both files are JSON objects and the user has both on disk.
 */
export const APP_DATA_KIND = "moseek-data";

/** Builds the file's text. Empty collections are omitted rather than written as `[]`. */
export function buildAppDataText(input: {
  theme?: ThemeMode;
  favorites?: VodFavorite[];
  liveFavorites?: LiveFavorite[];
}): string {
  const payload: AppDataFile = { kind: APP_DATA_KIND, schemaVersion: 1 };
  if (input.theme) payload.theme = input.theme;
  if (input.favorites?.length) payload.favorites = input.favorites;
  if (input.liveFavorites?.length) payload.liveFavorites = input.liveFavorites;
  return JSON.stringify(payload, null, 2);
}

/**
 * Reads a data file back.
 *
 * **Also accepts the old shape**, where the same fields lived under the configuration's `moseek` key.
 * A user who exported before this change has a file whose data is in that form, and refusing it would
 * lose the only copy they may have. The marker is not required in that case because the old format had
 * none — the presence of the `moseek` key is the evidence.
 *
 * Returns `null` when the text is neither shape, so the caller can say which file was expected.
 */
export function readAppDataText(text: string): MoseekExportExtras | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  if (record.kind === APP_DATA_KIND) {
    const extras: MoseekExportExtras = { schemaVersion: 1 };
    if (record.theme === "light" || record.theme === "dark" || record.theme === "system") {
      extras.theme = record.theme;
    }
    // Validated entry by entry, using the same normalisers the configuration importer uses. A length
    // check would accept `{ key: "bad" }`, which the store cannot render — and this file, like a
    // configuration, may have been edited or come from elsewhere.
    const favorites = sanitize(record.favorites, normalizeVodFavorite);
    if (favorites) extras.favorites = favorites;
    const liveFavorites = sanitize(record.liveFavorites, normalizeLiveFavorite);
    if (liveFavorites) extras.liveFavorites = liveFavorites;
    return extras;
  }

  // The old form: data nested under the configuration's own key. Delegated so the validation rules
  // cannot drift between the two readers.
  if (EXPORT_EXTRAS_KEY in record) {
    return readExportExtras(text);
  }

  return null;
}

/**
 * Keeps the entries a normaliser accepts, or `undefined` when the value is not a list.
 *
 * `undefined` and `[]` stay distinct: the caller uses the difference to decide whether the file said
 * anything about that collection at all, and an empty list would otherwise read as "the user has none".
 */
function sanitize<T>(
  value: unknown,
  normalize: (entry: unknown) => T | null,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(normalize).filter((entry): entry is T => entry !== null);
}
