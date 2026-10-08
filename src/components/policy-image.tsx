import { useEffect, useRef, useState, type ComponentProps } from "react";
import { cancelMediaRequest, fetchMediaResource, isTauriRuntime } from "@/lib/tauri";

/** Image bytes are fetched by Rust, so imported artwork cannot contact the local network. */
export function imageDataUrl(bodyBase64: string, contentType?: string | null) {
  const mime = contentType?.split(";", 1)[0]?.trim();
  const safeMime = mime && /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : "image/jpeg";
  return `data:${safeMime};base64,${bodyBase64}`;
}

export function isEmbeddedImage(src: string | undefined) {
  return Boolean(src && /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i.test(src));
}

/**
 * A transparent 1×1 GIF, used as the element's `src` until the real bytes arrive.
 *
 * **An `<img>` with no `src` is not blank — the browser paints a broken-image glyph and the alt
 * text in its place.** Measured in Chrome: `src` absent, `src=""` and a failed URL all render the
 * same broken icon with the alt text beside it, while a transparent pixel renders nothing. That is
 * the reported defect: on the desktop the bytes come from Rust, so for the first frames there was
 * nothing to point the element at, and every card in the grid began its life looking broken before
 * snapping to its artwork.
 *
 * A placeholder rather than hiding the element, and the difference is not cosmetic. The element has
 * to stay in the document and stay *visible to the accessibility tree* while it loads: the lazy path
 * observes it to decide when to fetch, its box defines the layout so the grid does not reflow when
 * the picture arrives, and hiding it with `visibility` removes it from that tree — which is exactly
 * how six poster-viewer tests failed when this was first written that way.
 */
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export function PolicyImage({ src, onError, onLoad, loading, ...props }: Omit<ComponentProps<"img">, "src" | "onError"> & {
  src?: string;
  onError?: () => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null);
  const desktop = isTauriRuntime() && !isEmbeddedImage(src);

  useEffect(() => {
    if (!desktop || !src) return;
    let cancelled = false;
    let started = false;
    const requestId = crypto.randomUUID();
    const start = () => {
      if (started || cancelled) return;
      started = true;
      void fetchMediaResource(src, {}, undefined, requestId).then((resource) => {
        if (cancelled) return;
        if (!resource) { onErrorRef.current?.(); return; }
        setResolved({ source: src, url: imageDataUrl(resource.bodyBase64, resource.contentType) });
      }).catch(() => { if (!cancelled) onErrorRef.current?.(); });
    };
    let observer: IntersectionObserver | undefined;
    if (loading === "lazy" && typeof IntersectionObserver !== "undefined" && imageRef.current) {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); start(); }
      });
      observer.observe(imageRef.current);
    } else start();
    return () => {
      cancelled = true;
      observer?.disconnect();
      if (started) void cancelMediaRequest(requestId).catch(() => undefined);
    };
  }, [desktop, src, loading]);

  const renderedSrc = desktop ? (resolved && resolved.source === src ? resolved.url : undefined) : src;
  /** Waiting for Rust: the placeholder is showing, so the real picture has not arrived yet. */
  const waiting = desktop && renderedSrc === undefined;
  return (
    <img
      {...props}
      ref={imageRef}
      loading={loading}
      src={waiting ? TRANSPARENT_PIXEL : renderedSrc}
      // The placeholder fires `load` the moment it paints. Forwarding that would tell a caller its
      // artwork had arrived when nothing had, so a poster would drop its loading state immediately
      // and then sit blank until the real bytes landed.
      onLoad={waiting ? undefined : onLoad}
      onError={() => onErrorRef.current?.()}
    />
  );
}
