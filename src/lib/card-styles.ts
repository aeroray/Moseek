/**
 * The hover treatment shared by every catalog card.
 *
 * Hover changes the border and nothing else. It used to lift the card and drop a shadow; on a
 * near-black surface a black shadow has nowhere to fall, so it read as a smudge rather than as
 * depth, and the lift made a grid of posters feel unsteady under the cursor. A border colour
 * change is enough to say "this is the one you are pointing at" without moving the artwork or
 * muddying the surface behind it.
 *
 * Shared rather than written out per card so the two grids cannot drift apart: the browse library
 * and the favourites page showing different hover treatments is exactly the kind of difference a
 * user notices without being able to name.
 */
export const catalogCardClassName = [
  "group relative flex flex-col overflow-hidden rounded-md border border-border/50 bg-card/60",
  "transition-[border-color,background-color] duration-200 ease-out",
  "hover:border-primary/40 hover:bg-card/80",
  "cursor-pointer",
].join(" ");

/**
 * The overlay a card shows on hover.
 *
 * A plain dim, with no blur: the point of the overlay is to mark the card as actionable, and
 * blurring the artwork underneath it works against the reason someone is looking at a poster
 * grid. The dim is kept light for the same reason.
 */
export const catalogCardOverlayClassName =
  "absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity duration-200 group-hover:opacity-100";

/**
 * The poster grid used by 影视库, which fills the whole content area.
 *
 * The breakpoints are viewport-based, which is correct here because this grid *is* the page.
 */
export const catalogGridClassName =
  "grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8";

/**
 * The poster grid used inside a half-width column.
 *
 * Viewport breakpoints cannot size this: 我的收藏 splits the content area in two, so at a 1440px
 * window the library's `xl:grid-cols-7` produced seven 76px covers — unreadable, and nothing like
 * the library it is meant to resemble. The tracks are keyed to the column's own width instead, so
 * the covers stay a sensible size whatever the window does.
 *
 * The column itself carries `@container`; a container query matches the nearest *ancestor*
 * container, so putting `@container` on this grid would make it query something else entirely and
 * the variants would never fire.
 */
export const columnGridClassName =
  "grid grid-cols-2 gap-3 @md:grid-cols-3 @4xl:grid-cols-4";
