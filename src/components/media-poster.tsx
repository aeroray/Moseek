import { useEffect, useState } from "react";

import { AppLogo } from "@/components/app-logo";
import { PolicyImage } from "@/components/policy-image";
import { cn } from "@/lib/utils";

type MediaPosterProps = {
  src?: string;
  alt: string;
  className?: string;
  imageClassName?: string;
};

/**
 * A work's poster, with a loading state and a fallback that survives the image failing.
 *
 * **The reported defect was a grid of broken images on every open, and an `<img>` with no `src` is
 * the cause.** Measured in Chrome: `src` absent, `src=""` and a failed URL all paint the browser's
 * broken-image glyph with the alt text beside it, while a transparent pixel paints nothing. On the
 * desktop the bytes come from Rust — the WebView never talks to the CDN — so for the first frames
 * there is nothing to point the element at, and every card in the grid began its life looking
 * broken. `PolicyImage` now hides the element until it has something to show, which removes the
 * glyph; this component adds the state that belongs in its place, because a blank box is not a
 * loading state.
 *
 * The pulse is deliberately the same `animate-pulse` surface the catalog skeleton uses, so the
 * placeholder a card shows while its own artwork loads matches the grid that was on screen a moment
 * earlier. One card finishing early changes only that card.
 */
export function MediaPoster({
  src,
  alt,
  className,
  imageClassName,
}: MediaPosterProps) {
  const [imageFailed, setImageFailed] = useState(!src?.trim());
  const [imageLoaded, setImageLoaded] = useState(false);

  useEffect(() => {
    setImageFailed(!src?.trim());
    // A new source is a new load. Without this, a card whose poster was replaced — which happens on
    // every page turn, since the grid reuses its rows — would keep the previous picture's pulse
    // state and could show a spinner over artwork that had already arrived.
    setImageLoaded(false);
  }, [src]);

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden bg-muted/60 transition-colors",
        className,
      )}
    >
      {!imageFailed ? (
        <>
          {/* Behind the artwork and removed the moment it lands, so the animation is not left
              running under an image that covers it. `aria-hidden` because it is a decoration: a
              screen reader should hear the work's name once, from the image's own alt text. */}
          {!imageLoaded && (
            <div
              aria-hidden="true"
              className="absolute inset-0 animate-pulse bg-muted/70"
            />
          )}
          <PolicyImage
            src={src}
            alt={alt}
            loading="lazy"
            className={cn("size-full object-cover", imageClassName)}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageFailed(true)}
          />
        </>
      ) : (
        <div
          role="img"
          aria-label={`${alt}，暂无可用图片`}
          className="flex size-full flex-col items-center justify-center gap-1.5 bg-gradient-to-b from-card/80 to-muted/80 select-none"
        >
          {/* The product mark rather than a generic film glyph: this is the app's own surface, and
              the mark is what identifies it. Dimmed so it cannot be mistaken for loaded artwork. */}
          <AppLogo className="size-6 rounded opacity-45" />
          <span className="text-xs font-medium tracking-tight text-muted-foreground/60">
            暂无海报
          </span>
        </div>
      )}
    </div>
  );
}
