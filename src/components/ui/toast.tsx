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
        "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border border-border/80 bg-card/95 p-3.5 text-sm shadow-2xl backdrop-blur-md",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-top-full data-[state=open]:animate-in data-[state=open]:slide-in-from-top-full",
        variant === "success" &&
          "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)]",
        variant === "error" && "border-destructive/40 bg-destructive/10",
        className
      )}
      {...props}
    />
  )
}

function ToastIcon({ variant }: { variant: "info" | "success" | "error" }) {
  const Icon =
    variant === "success" ? CircleCheck : variant === "error" ? CircleX : Info
  return (
    <Icon
      className={cn(
        "mt-0.5 size-4 shrink-0",
        variant === "success" && "text-[color:var(--status-supported)]",
        variant === "error" && "text-destructive",
        variant === "info" && "text-muted-foreground"
      )}
      aria-hidden="true"
    />
  )
}

function ToastTitle({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("font-medium text-foreground", className)}
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

function ToastClose({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="关闭提示"
      className={cn(
        "ml-auto shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
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
