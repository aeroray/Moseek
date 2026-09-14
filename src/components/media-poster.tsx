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
    <div className={cn("relative w-full overflow-hidden bg-muted", className)}>
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
          className="flex size-full flex-col items-center justify-center gap-2 bg-muted text-muted-foreground"
        >
          <Film data-icon="inline-start" aria-hidden="true" />
          <span className="text-xs">暂无海报</span>
        </div>
      )}
    </div>
  );
}
