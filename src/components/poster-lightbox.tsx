import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Expand,
  ImageOff,
  Loader2,
  Maximize2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { PolicyImage } from "@/components/policy-image";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOptionalToast } from "@/components/toast-host";
import { resolveLargestPoster } from "@/components/poster-candidates";
import { downloadImage, isTauriRuntime } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const MIN_SCALE = 1;
const MAX_SCALE = 6;
/** One wheel notch. Small enough to feel continuous, large enough to make progress. */
const WHEEL_STEP = 0.2;
const BUTTON_STEP = 0.5;

/**
 * The offset after dragging from `start` to `current`.
 *
 * Extracted so the pan maths can be tested directly. jsdom does not implement `PointerEvent`, so
 * a synthetic pointer event arrives with `clientX` undefined and the coordinates cannot be
 * delivered through the DOM at all — the arithmetic is the part worth pinning, and it is the part
 * that a coordinate-system mistake would break.
 */
export function nextPanOffset(
  origin: { x: number; y: number },
  start: { x: number; y: number },
  current: { x: number; y: number },
) {
  return {
    x: origin.x + (current.x - start.x),
    y: origin.y + (current.y - start.y),
  };
}

interface PosterZoomButtonProps {
  name: string;
  poster: string;
  className?: string;
}

/**
 * The poster viewer's trigger.
 *
 * Deliberately a plain button rather than something the card wires up: the poster belongs to the
 * work's own page, where the artwork is shown as metadata and inspecting it is a natural thing to
 * want. On a browsing grid the card already means "play this", and a second action competing with
 * that made the grid noisier than it was useful.
 */
export function PosterZoomButton({ name, poster, className }: PosterZoomButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!poster?.trim()) return null;

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen(true);
        }}
        aria-label={`查看 ${name} 的海报大图`}
        title="查看大图"
        className={cn(
          "flex size-7 items-center justify-center rounded-full bg-black/65 text-white/90 backdrop-blur-xs transition-all duration-200 hover:scale-110 hover:bg-black/80 hover:text-white active:scale-95",
          className,
        )}
      >
        <Expand className="size-3.5" aria-hidden="true" />
      </button>
      <PosterLightbox
        name={name}
        poster={poster}
        open={isOpen}
        onOpenChange={setIsOpen}
      />
    </>
  );
}

/**
 * The poster at full size, with zoom, pan and download.
 *
 * The image is resolved to its largest available variant on open, because the address a source
 * lists is often a thumbnail and the point of opening it is to see the detail. The original is
 * always the fallback, so a source that publishes only one size still works.
 *
 * Zoom and pan are local state rather than a transform on a wrapper: the scale is applied to the
 * image and the pan to its offset, so resetting is exact and the pointer maths stays in one place.
 */
export function PosterLightbox({
  name,
  poster,
  open,
  onOpenChange,
}: {
  name: string;
  poster: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pushToast = useOptionalToast();
  const [isSaving, setIsSaving] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState(poster);
  const [isResolving, setIsResolving] = useState(false);
  const [scale, setScale] = useState(MIN_SCALE);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const viewportRef = useRef<HTMLDivElement | null>(null);
  /** The pointer position at drag start, and the offset it started from. */
  const dragRef = useRef({ x: 0, y: 0, originX: 0, originY: 0 });
  /**
   * Whether a drag is in progress.
   *
   * A ref, not state. React state is not updated until the next render, so a `pointermove`
   * arriving before that render would read the old value and discard the movement — which is
   * exactly what happened: the first move of every drag was dropped, so panning appeared not to
   * work at all. The ref is set synchronously; the state exists only to drive the cursor.
   */
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  /**
   * Returns the image to its resting state.
   *
   * Only the scale is set. The offset is cleared by the effect below whenever the scale reaches
   * 1x, so writing it here too would be a second mechanism for the same invariant — and two
   * mechanisms that must agree are how they eventually stop agreeing.
   */
  const reset = useCallback(() => {
    setScale(MIN_SCALE);
  }, []);

  // Every open starts from a clean slate: the previous poster's zoom has no meaning for this one.
  useEffect(() => {
    if (!open) return;
    setImageFailed(false);
    reset();
    setResolvedUrl(poster);
    setIsResolving(true);
    let cancelled = false;
    void resolveLargestPoster(poster)
      .then((best) => {
        if (cancelled) return;
        // A resolution that found nothing better reports no dimensions; keeping the original
        // address in that case is what makes this safe to always attempt.
        if (best.width > 0) setResolvedUrl(best.url);
      })
      .finally(() => {
        if (!cancelled) setIsResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, poster, reset]);

  /**
   * Zooms around the centre, clamped so the image cannot be lost or over-magnified.
   *
   * The clamp lives in the updater, but the offset reset does not: calling another `setState`
   * from inside an updater is a side effect during the render phase, which React may run twice
   * and which does not reliably apply. Returning to 1x clears the pan in an effect instead.
   */
  const zoomBy = useCallback((delta: number) => {
    setScale((current) =>
      Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + delta)),
    );
  }, []);

  // At 1x there is nowhere to pan, so any leftover offset is dropped. Doing it here also means
  // "zoomed all the way out" and "reset" cannot leave the image in two different-looking places.
  useEffect(() => {
    if (scale === MIN_SCALE) setOffset({ x: 0, y: 0 });
  }, [scale]);

  /**
   * Wheel zoom.
   *
   * Registered as a non-passive listener rather than through React's `onWheel`, because React
   * attaches wheel handlers passively and `preventDefault` would be ignored — the page behind the
   * dialog would scroll while the user was zooming.
   *
   * Attached through a callback ref rather than an effect on `viewportRef.current`: Radix mounts
   * the dialog's content through a portal in a later commit, so on the effect's first run the
   * node does not exist yet and the listener was never attached at all. A callback ref runs
   * exactly when the node arrives.
   */
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  const wheelListenerRef = useRef<((event: WheelEvent) => void) | null>(null);
  if (!wheelListenerRef.current) {
    // Created once and kept, so the same function can be added and removed. Rebuilding it per
    // render would leave the old one attached forever.
    wheelListenerRef.current = (event: WheelEvent) => {
      event.preventDefault();
      zoomByRef.current(event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP);
    };
  }
  const attachViewport = useCallback((node: HTMLDivElement | null) => {
    const listener = wheelListenerRef.current;
    const previous = viewportRef.current;
    if (previous && listener) previous.removeEventListener("wheel", listener);
    viewportRef.current = node;
    if (node && listener) {
      node.addEventListener("wheel", listener, { passive: false });
    }
  }, []);

  const startDrag = (event: React.PointerEvent) => {
    // Panning only means something once the image is larger than the frame.
    if (scale <= MIN_SCALE) return;
    event.preventDefault();
    // Capture keeps the drag alive when the pointer leaves the frame, but it is an enhancement:
    // it throws if the pointer id is not an active pointer, and letting that propagate would
    // abort the handler before the drag started, breaking panning entirely.
    try {
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // Without capture the drag still works while the pointer stays inside the frame.
    }
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    isDraggingRef.current = true;
    setIsDragging(true);
  };

  const moveDrag = (event: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    setOffset(
      nextPanOffset(
        { x: dragRef.current.originX, y: dragRef.current.originY },
        { x: dragRef.current.x, y: dragRef.current.y },
        { x: event.clientX, y: event.clientY },
      ),
    );
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    try {
      (event.target as Element).releasePointerCapture?.(event.pointerId);
    } catch {
      // Releasing a capture that was never taken is not a failure worth surfacing.
    }
    isDraggingRef.current = false;
    setIsDragging(false);
  };

  const save = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      // The resolved address is saved, not the thumbnail the source listed — downloading the
      // small one after being shown the large one would be a quiet bait and switch.
      const saved = await downloadImage(resolvedUrl, name);
      if (saved) {
        pushToast({
          title: "已保存海报",
          description: saved.path,
          variant: "success",
        });
      } else if (!isTauriRuntime()) {
        pushToast({
          title: "浏览器预览无法保存",
          description: "请在桌面应用中使用下载功能。",
          variant: "info",
        });
      }
    } catch (error) {
      pushToast({
        title: "保存失败",
        description:
          error instanceof Error ? error.message : "无法保存这张图片。",
        variant: "error",
      });
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, name, pushToast, resolvedUrl]);

  const zoomPercent = Math.round(scale * 100);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] max-w-[min(94vw,72rem)] gap-0 overflow-hidden border-border/60 bg-card/95 p-0 backdrop-blur-md sm:max-w-[min(94vw,72rem)]"
        showCloseButton={false}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate text-sm font-semibold text-foreground">
              {name}
            </DialogTitle>
            <DialogDescription className="sr-only">
              查看海报大图，可缩放并下载保存到本地
            </DialogDescription>
            {isResolving && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                正在获取高清图
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {/* Zoom controls. The percentage is the only label: it states the current state, which
                is the thing a user actually needs to read here. */}
            <span
              className="mr-1 w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
              aria-live="polite"
            >
              {zoomPercent}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="缩小"
              title="缩小"
              disabled={scale <= MIN_SCALE}
              onClick={() => zoomBy(-BUTTON_STEP)}
            >
              <ZoomOut className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="放大"
              title="放大"
              disabled={scale >= MAX_SCALE}
              onClick={() => zoomBy(BUTTON_STEP)}
            >
              <ZoomIn className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="重置"
              title="重置"
              disabled={scale === MIN_SCALE && offset.x === 0 && offset.y === 0}
              onClick={reset}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
            </Button>

            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

            {/* Icon-only download: the icon is unambiguous and the row is already busy. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="下载"
              title="下载"
              disabled={isSaving}
              onClick={() => void save()}
            >
              {isSaving ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="关闭"
              title="关闭"
              onClick={() => onOpenChange(false)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        {/* The viewport clips; the image is transformed inside it. `touch-none` stops the browser
            from claiming a drag as a scroll gesture before the pointer handlers see it. */}
        <div
          ref={attachViewport}
          data-slot="poster-viewport"
          className={cn(
            "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/50 p-4",
            scale > MIN_SCALE ? (isDragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default",
          )}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ touchAction: "none" }}
        >
          {imageFailed ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <ImageOff className="size-7 opacity-50" aria-hidden="true" />
              <p className="text-sm">这张海报无法加载</p>
              <p className="text-xs opacity-80">
                图片地址可能已经失效，可以稍后重试或换一个源。
              </p>
            </div>
          ) : (
            <PolicyImage
              src={resolvedUrl}
              alt={`${name} 海报大图`}
              draggable={false}
              className="max-h-[calc(100vh-11rem)] w-auto max-w-full rounded object-contain select-none"
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                // The transition is suppressed while dragging, or the image lags the pointer.
                transition: isDragging ? "none" : "transform 120ms ease-out",
              }}
              onError={() => setImageFailed(true)}
            />
          )}

          {/* A hint shown only while the image is at rest, so it explains the interactions without
              sitting on top of the artwork the user came to look at. */}
          {!imageFailed && scale === MIN_SCALE && (
            <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white/70 backdrop-blur-xs">
              滚轮缩放 · 放大后可拖动
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Kept for callers that need the icon on its own. */
export const PosterZoomIcon = Maximize2;
