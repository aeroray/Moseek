"use client"

import * as React from "react"
import { cn } from "cn"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

/**
 * Extra classes for the viewport.
 *
 * Radix renders the viewport's children inside a wrapper it styles inline as
 * `display: table; min-width: 100%`. A table sizes to its content, so that wrapper grows to fit
 * the widest child instead of the viewport's width, and `truncate` on anything inside it silently
 * stops working — the text ellipsises only once the row is already wider than the visible area,
 * which is to say never.
 *
 * A vertical list whose rows must respect the width passes `[&>div]:!block` here. The
 * `!important` is unavoidable: the declaration being overridden is inline. The table display
 * exists to support a horizontal scrollbar, so it must not be changed for every caller.
 */
type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string
  /**
   * The viewport element, which is the thing that actually scrolls.
   *
   * Radix's `Root` is the outer box; the scrolling happens on the inner `Viewport`, so a caller that
   * needs to observe or drive the scroll position — a virtualiser, for instance — cannot use a ref on
   * `Root` for it. Exposed here rather than letting callers reach in with `querySelector`, which would
   * break silently if Radix ever changed its internal markup.
   */
  viewportRef?: React.Ref<HTMLDivElement>
}

function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  children,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          viewportClassName
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-0.5 transition-colors select-none z-20",
        orientation === "vertical" &&
          "h-full w-2 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-muted-foreground/30 hover:bg-muted-foreground/50 transition-colors"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
