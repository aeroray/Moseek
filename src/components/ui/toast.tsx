import * as React from "react"
import { Toast as ToastPrimitive } from "radix-ui"
import { CircleCheck, CircleX, Info, X } from "lucide-react"

import { cn } from "cn"

/**
 * A single transient notice, anchored to the top centre of the viewport.
 *
 * The page used to report the outcome of a test run in a banner pinned below the source list,
 * which stayed there until the next action replaced it — the result of an operation the user had
 * already finished reading about. A toast reports the same thing once and leaves.
 *
 * **The surface is the app's ordinary card, and the colour lives only in the icon.** It used to paint
 * the whole notice with the status palette — `--status-supported-bg`, a 12%-opacity green — which is a
 * tint designed for a small badge in a table cell. Filling a 24rem-wide panel with it produced a block
 * of green that read as a different application: the interface is obsidian cards with a hairline
 * border, and the only saturated colour on it is the amber primary. Tinting the icon instead says the
 * same thing at a scale where it is legible, and leaves the body on `bg-card` like every other panel.
 *
 * **The shadow stays.** It is `shadow-xl` rather than `shadow-2xl` — one step down, matching
 * `select`/`dropdown-menu`, which is the same class of panel — but it is not removed: on this obsidian
 * background a small shadow reads as a flat box rather than as a floating surface, which is the rule
 * `dropdown-menu.tsx` records for every overlay in this project. The reported problem was the green
 * fill, not the elevation.
 */
function ToastProvider({
  children,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Provider>) {
  return (
    <ToastPrimitive.Provider
      swipeDirection="up"
      duration={5000}
      {...props}
    >
      {children}
      <ToastPrimitive.Viewport
        data-slot="toast-viewport"
        className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex max-h-screen flex-col items-center gap-2 p-4 outline-none"
      />
    </ToastPrimitive.Provider>
  )
}

function Toast({
  className,
  variant = "info",
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root> & {
  variant?: "info" | "success" | "error"
}) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      data-variant={variant}
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-border/80 bg-card/95 p-3.5 text-sm shadow-xl backdrop-blur-md",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-top-full data-[state=open]:animate-in data-[state=open]:slide-in-from-top-full",
        // Only the border carries the outcome. A destructive notice is the one case that earns more:
        // it is the only variant reporting something the user may need to act on, so it gets a red
        // hairline rather than the same neutral one as a routine confirmation.
        variant === "error" && "border-destructive/40",
        className
      )}
      {...props}
    />
  )
}

/**
 * The outcome, as an icon rather than as a painted panel.
 *
 * `CircleCheck` in the supported colour is the same pairing `CapabilityBadge` uses for 可用, so the
 * vocabulary is consistent between a row and a notice about that row. The icon sits in a faint ring of
 * its own colour, which is what carries the eye to it now that the background no longer does.
 */
function ToastIcon({ variant }: { variant: "info" | "success" | "error" }) {
  const Icon =
    variant === "success" ? CircleCheck : variant === "error" ? CircleX : Info
  return (
    <span
      className={cn(
        "mt-px flex size-6 shrink-0 items-center justify-center rounded-full",
        variant === "success" &&
          "bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
        variant === "error" && "bg-destructive/10 text-destructive",
        variant === "info" && "bg-muted text-muted-foreground",
      )}
      aria-hidden="true"
    >
      <Icon className="size-3.5" />
    </span>
  )
}

function ToastTitle({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("text-[13px] leading-5 font-medium text-foreground", className)}
      {...props}
    />
  )
}

function ToastDescription({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("mt-0.5 text-xs leading-5 text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * The dismiss control.
 *
 * `-mr-1 -mt-1` pulls it towards the corner it belongs in: the card's padding is sized for the text,
 * and a close button aligned to that padding sits visibly short of the edge it is closing.
 */
function ToastClose({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="关闭提示"
      className={cn(
        "-mr-1 -mt-1 ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        className
      )}
      {...props}
    >
      <X className="size-3.5" aria-hidden="true" />
    </ToastPrimitive.Close>
  )
}

export {
  ToastProvider,
  Toast,
  ToastIcon,
  ToastTitle,
  ToastDescription,
  ToastClose,
}
