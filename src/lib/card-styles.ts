/**
 * The hover treatment shared by every catalog card.
 *
 * Previously each card lifted 4px and dropped a wide 40%-black shadow. On a near-black surface a
 * black shadow has nowhere to fall, so instead of reading as depth it reads as a smudge — the
 * card looked dirty rather than raised. This keeps the lift to 2px and pulls the shadow in with a
 * negative spread, so the card comes forward while the surface behind it stays clean. The border
 * carries most of the emphasis, which is what actually reads at this size.
 *
 * Shared rather than written out per card so the two grids cannot drift apart: the browse library
 * and the favourites page showing different hover treatments is exactly the kind of difference a
 * user notices without being able to name.
 */
export const catalogCardClassName = [
  "group relative flex flex-col overflow-hidden rounded-md border border-border/50 bg-card/60",
  "transition-[transform,border-color,box-shadow] duration-200 ease-out",
  "hover:-translate-y-0.5 hover:border-primary/40",
  "hover:shadow-[0_10px_28px_-16px_rgba(0,0,0,0.9),0_2px_8px_-4px_rgba(0,0,0,0.45)]",
  "cursor-pointer",
].join(" ");

/**
 * The overlay a card shows on hover.
 *
 * Kept dimmer than before for the same reason as the shadow: a 40% black wash over a dark poster
 * muddies the artwork, and the action circle already marks the card as interactive.
 */
export const catalogCardOverlayClassName =
  "absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 backdrop-blur-[1px] transition-opacity duration-200 group-hover:opacity-100";
