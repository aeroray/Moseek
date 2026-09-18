import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The pieces shared by the two-column surfaces.
 *
 * 足迹 and 我的收藏 both present a pair of named columns over different data. They are different
 * kinds of surface — one is a record of the past, the other a collection you act on — so only the
 * frame is shared: the heading, the empty state, and the small token used for the discrete facts
 * on a row. Keeping the frame in one place is what stops the two pages drifting into looking
 * almost-alike, which is the kind of difference a user notices without being able to name.
 */

/** The heading above a column: an icon tile, the name, and how much is in it. */
export function ColumnHeader({
  tone,
  icon,
  title,
  count,
}: {
  tone: "vod" | "live";
  icon: ReactNode;
  title: string;
  count: number;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md",
          tone === "vod"
            ? "bg-primary/12 text-primary"
            : "bg-sky-400/12 text-sky-400",
        )}
      >
        {icon}
      </span>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <span className="text-xs tabular-nums text-muted-foreground">
        {count} 条
      </span>
      {/* No hairline filling the remaining width. It read as a rule belonging to the page rather
          than to the column, and it competed with the day rules inside the timeline, which are the
          ones that actually carry meaning. */}
    </div>
  );
}

/** The empty state for one column, which keeps its shape so the page still reads as two panels. */
export function ColumnEmpty({
  tone,
  icon,
  title,
  hint,
  actionLabel,
  onAction,
}: {
  tone: "vod" | "live";
  icon: ReactNode;
  title: string;
  hint: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-10 text-center">
      <span
        className={cn(
          "flex size-8 items-center justify-center rounded-full",
          tone === "vod"
            ? "bg-primary/10 text-primary/80"
            : "bg-sky-400/10 text-sky-400/80",
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="max-w-xs text-xs leading-5 text-muted-foreground">{hint}</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-1"
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </div>
  );
}

/** A small labelled token, used for the discrete named facts on a row. */
export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "live";
}) {
  return (
    <span
      className={cn(
        "min-w-0 max-w-full truncate rounded px-1.5 py-0.5 text-[11px] leading-4",
        tone === "neutral" && "bg-muted text-foreground/75",
        tone === "accent" && "bg-primary/12 text-primary/90",
        tone === "live" && "bg-sky-400/12 text-sky-400/90",
      )}
    >
      {children}
    </span>
  );
}

/** `m:ss` — a position inside an episode, not a time of day. */
export function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** `HH:MM` — the clock time, since the day is stated separately where this is used. */
export function formatClockTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}
