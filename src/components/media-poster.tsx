import { useEffect, useState } from "react";
import { Film } from "lucide-react";

import { cn } from "@/lib/utils";

type MediaPosterProps = {
  src?: string;
  alt: string;
  className?: string;
  imageClassName?: string;
};

export function MediaPoster({
  src,
  alt,
  className,
  imageClassName,
}: MediaPosterProps) {
  const [imageFailed, setImageFailed] = useState(!src?.trim());

  useEffect(() => {
    setImageFailed(!src?.trim());
  }, [src]);

  return (
    <div className={cn("relative w-full overflow-hidden bg-muted/60 transition-colors", className)}>
      {!imageFailed ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className={cn("size-full object-cover", imageClassName)}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div
          role="img"
          aria-label={`${alt}，暂无可用图片`}
          className="flex size-full flex-col items-center justify-center gap-1.5 bg-gradient-to-b from-card/80 to-muted/80 text-muted-foreground/60 select-none"
        >
          <Film data-icon="inline-start" aria-hidden="true" className="size-5 opacity-40" />
          <span className="text-xs font-medium tracking-tight">拾影</span>
        </div>
      )}
    </div>
  );
}
