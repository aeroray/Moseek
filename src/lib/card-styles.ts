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
