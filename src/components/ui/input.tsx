import * as React from "react"
import { cn } from "cn"

function Input({
  className,
  size = "default",
  type,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & {
  size?: "sm" | "default"
}) {
  return (
    <input
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        "w-full min-w-0 rounded-md border border-input/80 bg-input/20 shadow-2xs transition-all outline-none selection:bg-primary/30 selection:text-primary file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/60 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        // Size classes must stay plain, not `data-[size=*]:` variants. A variant selector
        // like `.data-[size=sm]:px-2.5[data-size=sm]` scores (0,1,2) and therefore beats a
        // caller's `pl-8` at (0,1,0) regardless of source order, so `cn()` could not let a
        // caller override the padding. Left/right are set separately so that a caller
        // passing only `pl-8` still merges correctly instead of losing to `px-*`.
        size === "sm"
          ? "h-8 pl-2.5 pr-2.5 py-0.5 text-xs"
          : "h-9 pl-3 pr-3 py-1 text-sm",
        "focus-visible:border-primary/60 focus-visible:bg-input/40 focus-visible:ring-2 focus-visible:ring-primary/20",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
