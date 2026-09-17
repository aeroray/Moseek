import { cn } from "@/lib/utils";

/**
 * The product mark: a rounded black tile carrying a white movie camera.
 *
 * Inline SVG rather than an image file so it inherits `currentColor` where needed and cannot
 * flash while a separate request resolves. The tile colour is the app's own near-black rather
 * than pure black, so the mark sits on the shell instead of punching a hole in it.
 *
 * Drawn on a 256-unit grid with generous strokes: the mark is rendered as small as 20px in the
 * navigation rail, and a finer drawing turns to mush there. Two reels were chosen over one
 * because a single reel at that size reads as an unidentifiable blob, while two register as a
 * camera even when the detail is gone.
 */
export function AppLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 256 256"
      role="img"
      aria-label="拾影"
      className={cn("size-5", className)}
    >
      <rect width="256" height="256" rx="56" fill="#0B0D12" />
      <g fill="#FFFFFF">
        <path d="M28 118a26 26 0 0 1 26-26h104a26 26 0 0 1 26 26v64a26 26 0 0 1-26 26H54a26 26 0 0 1-26-26v-64Z" />
        <circle cx="84" cy="70" r="40" />
        <circle cx="150" cy="70" r="40" />
        <rect x="176" y="126" width="34" height="48" rx="8" />
        <circle cx="212" cy="150" r="28" />
      </g>
      <g fill="#0B0D12">
        <circle cx="84" cy="70" r="13" />
        <circle cx="150" cy="70" r="13" />
        <circle cx="212" cy="150" r="12" />
      </g>
    </svg>
  );
}
