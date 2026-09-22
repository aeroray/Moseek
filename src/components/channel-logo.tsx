import { useEffect, useState } from "react";
import { Radio } from "lucide-react";

import { cn } from "@/lib/utils";

type ChannelLogoProps = {
  src?: string;
  /** The channel's name, used for the accessible label rather than shown on screen. */
  name: string;
  className?: string;
  iconClassName?: string;
};

/**
 * A live channel's logo, with a fallback that survives the image failing.
 *
 * The favourites page and 足迹 both showed a channel's `logoUrl` through a bare `<img>` whose only
 * fallback was an empty string — so a logo that failed to load left the browser's broken-image
 * glyph inside the artwork slot, which reads as a defect in Moseek rather than as a picture the
 * source could not serve. `MediaPoster` already handled this for films; channels had no equivalent.
 *
 * The fallback is the same mark in both places, and deliberately *not* an album-art placeholder
 * shared with films: a channel has no poster, so it gets the radio glyph the rest of the live
 * surfaces use. Sharing the component is what keeps the two channel surfaces from drifting.
 *
 * Verified against the user's own configuration first: all 1769 logo URLs answer HTTP 200 from a
 * plain client, including the 157 plain-`http` ones, so the failures are client-side or
 * host-side and intermittent — which is exactly the case a fallback is for, and not something a
 * URL rewrite could have fixed.
 */
export function ChannelLogo({
  src,
  name,
  className,
  iconClassName,
}: ChannelLogoProps) {
  const [failed, setFailed] = useState(!src?.trim());

  // A new source means a fresh chance: without this, a channel whose logo failed would keep
  // showing the fallback even after a working logo replaced it.
  useEffect(() => {
    setFailed(!src?.trim());
  }, [src]);

  return (
    <span
      className={cn(
        "flex items-center justify-center overflow-hidden",
        className,
      )}
    >
      {!failed ? (
        <img
          src={src}
          alt={`${name} 台标`}
          loading="lazy"
          // `referrerPolicy` is left at the browser default on purpose. The logos that load come
          // from CDNs that answered 200 both with and without a Referer in testing, so suppressing
          // it would buy nothing and would break any host that does require one.
          className="size-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <Radio
          className={cn("size-5 text-muted-foreground/70", iconClassName)}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
