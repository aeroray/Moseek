import { useCallback, useEffect, useRef, useState } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface TruncatedTextProps {
  children: string;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * Text that ellipsises when it does not fit, and only then offers a tooltip with the full value.
 *
 * A tooltip on every row would be noise: most names fit, and a hover card repeating the text
 * already on screen tells the user nothing. So the element is measured and the tooltip is
 * attached only when it is genuinely clipped. The measurement is re-run on resize, because a
 * name can start or stop overflowing when the pane or the font size changes.
 *
 * The caller must give this a width constraint (`min-w-0` inside a flex row, or a fixed width).
 * Without one the span grows to its content and never reports itself as truncated.
 */
export function TruncatedText({
  children,
  className,
  side = "right",
}: TruncatedTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    // One pixel of tolerance: sub-pixel layout rounding otherwise reports a clipped element on
    // a name that fits exactly, which shows a tooltip duplicating the visible text.
    setIsTruncated(node.scrollWidth > node.clientWidth + 1);
  }, []);

  useEffect(() => {
    measure();
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, children]);

  const text = (
    <span ref={ref} className={cn("min-w-0 truncate", className)}>
      {children}
    </span>
  );

  if (!isTruncated) return text;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{text}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs font-medium">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
