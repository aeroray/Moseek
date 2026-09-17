import { useCallback, useEffect, useState } from "react";
import { Download, Expand, ImageOff, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOptionalToast } from "@/components/toast-host";
import { downloadImage, isTauriRuntime } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface PosterZoomButtonProps {
  name: string;
  poster: string;
  className?: string;
}

/**
 * The poster actions button, shown on a card.
 *
 * A separate control from the card itself so opening the image does not open the work: the two
 * are different intentions and the card already means "play this".
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
 * The poster at full size, with a download action.
 *
 * The image is shown at its natural resolution rather than scaled up: enlarging a poster past its
 * real pixel size invents detail that is not there, and the user asked for the high-definition
 * image, which is what the source actually serves.
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

  // A new poster deserves a fresh attempt; a failure on one says nothing about the next.
  useEffect(() => {
    if (open) setImageFailed(false);
  }, [open, poster]);

  const save = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const saved = await downloadImage(poster, name);
      // A null result means the picker was dismissed or there is no desktop runtime, neither of
      // which is a failure. Reporting "saved" for a cancelled dialog would be a lie, and
      // reporting an error for a deliberate cancellation would be noise.
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
  }, [isSaving, name, poster, pushToast]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // The poster is the content, so the dialog is sized to it and drops the usual padding and
        // close button in favour of a bar that carries the actions.
        className="max-h-[calc(100vh-2rem)] max-w-[min(92vw,64rem)] gap-0 overflow-hidden border-border/60 bg-card/95 p-0 backdrop-blur-md sm:max-w-[min(92vw,64rem)]"
        showCloseButton={false}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate text-sm font-semibold text-foreground">
              {name}
            </DialogTitle>
            <DialogDescription className="sr-only">
              查看海报大图，可下载保存到本地
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSaving}
              onClick={() => void save()}
            >
              {isSaving ? (
                <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" aria-hidden="true" />
              ) : (
                <Download className="size-3.5" data-icon="inline-start" aria-hidden="true" />
              )}
              {isSaving ? "正在保存…" : "下载"}
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

        {/* The image area scrolls rather than the dialog, so the action bar stays put however
            tall the poster is. */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/40 p-4">
          {imageFailed ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <ImageOff className="size-7 opacity-50" aria-hidden="true" />
              <p className="text-sm">这张海报无法加载</p>
              <p className="text-xs opacity-80">
                图片地址可能已经失效，可以稍后重试或换一个源。
              </p>
            </div>
          ) : (
            <img
              src={poster}
              alt={`${name} 海报大图`}
              // No forced size: the image renders at its own resolution, bounded by the dialog.
              className="max-h-[calc(100vh-11rem)] w-auto max-w-full rounded object-contain"
              onError={() => setImageFailed(true)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
