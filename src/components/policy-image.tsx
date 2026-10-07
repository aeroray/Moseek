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

export function PolicyImage({ src, onError, loading, ...props }: Omit<ComponentProps<"img">, "src" | "onError"> & {
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
  return <img {...props} ref={imageRef} loading={loading} src={renderedSrc} onError={() => onErrorRef.current?.()} />;
}
