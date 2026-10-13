/**
 * Every product fact the interface shows, in one place.
 *
 * **Why this exists.** The version was written in three files and compared at release time
 * (`scripts/sync-version.mjs` does that check), but the *display* facts around it — the product name,
 * the Chinese name, the slogan — were scattered across the window bar, the update panel and the
 * installer configuration. Raising a release meant knowing all of them.
 *
 * The number itself is still read from `package.json` through the build-time `__APP_VERSION__`
 * literal rather than repeated here, so this module cannot drift from what the installer carries:
 * `sync-version.mjs` remains the only thing that writes a version, and it writes it to one file.
 */

/** SemVer, e.g. `1.0.0`. No `v` prefix — the interface adds none, and neither should a caller. */
export const APP_VERSION = __APP_VERSION__;

/** The product's name as a user writes it. */
export const APP_NAME = "拾影";

/** The internal identifier. Shown nowhere in the interface; it is what the repository is called. */
export const APP_CODE_NAME = "Moseek";

/** One line describing what the app is for. Shown as the mark's tooltip, never as visible text. */
export const APP_SLOGAN = "万千影视，一拾即得";

/**
 * The version as it should appear on screen: the bare number.
 *
 * **A named helper rather than template literals at each call site**, because the `v` prefix was
 * being added in two places and removed in none. It reads as noise next to a field already labelled
 * 版本, and it made the string in the update banner disagree with the string beside the badge.
 */
export function formatVersion(version: string = APP_VERSION) {
  return version.replace(/^v/i, "");
}
