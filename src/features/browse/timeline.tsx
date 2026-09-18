import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The pieces the two-column timeline surfaces share.
 *
 * 足迹 and 我的收藏 present the same shape — a heading with a count, then a rail with one node per
 * entry, grouped by day — over different data. Keeping the rail, the chip and the day grouping in
 * one place is what stops the two pages drifting into looking almost-alike, which is the kind of
 * difference a user notices without being able to name.
 */

/** The heading above a column: an icon tile, the name, and how much is in it. */
export function TimelineColumnHeader({
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

/**
 * The rail beside an entry: a continuous line and a node.
 *
 * The line is drawn behind the node rather than as a border on the row, so it survives rows of
 * different heights without the spacing drifting. The node is two parts — a soft halo around a
 * solid core — because a single flat dot reads as a bullet, and the halo is what makes it read as
 * a point on a line.
 *
 * `isLast` must mean last in the whole column, not last in the current day group: ending the line
 * at every day boundary leaves a column with one entry per day drawing no line at all.
 */
export function TimelineRail({
  tone,
  isLast,
}: {
  tone: "vod" | "live";
  isLast: boolean;
}) {
  return (
    <div className="relative flex w-4 shrink-0 justify-center">
      {!isLast && (
        <span
          className={cn(
            "absolute top-5 bottom-[-0.5rem] w-px",
            tone === "vod" ? "bg-primary/20" : "bg-sky-400/20",
          )}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          "relative z-10 mt-[1.15rem] flex size-2.5 shrink-0 items-center justify-center rounded-full ring-[3px] ring-background",
          tone === "vod" ? "bg-primary/25" : "bg-sky-400/25",
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            tone === "vod" ? "bg-primary" : "bg-sky-400",
          )}
        />
      </span>
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

/**
 * The day heading that opens each group.
 *
 * Grouping by day is what makes a list of rows a timeline: it answers "when" before the reader
 * parses a timestamp, and it lets each row show only a clock time.
 */
export function DayHeading({ label }: { label: string }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
    </div>
  );
}

/** The empty state for one column, which keeps its shape so the page still reads as two panels. */
export function TimelineColumnEmpty({
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

export interface DayGroup<T> {
  key: string;
  label: string;
  records: T[];
}

/**
 * Splits an already newest-first list into consecutive days.
 *
 * Consecutive grouping is enough and avoids a second sort: the list arrives ordered, so records
 * sharing a day are already adjacent. A record with an unparseable timestamp becomes its own
 * group rather than being silently merged into the day above it, which would misreport when it
 * happened.
 */
export function groupByDay<T>(
  records: T[],
  timestampOf: (record: T) => string,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const record of records) {
    const value = timestampOf(record);
    const date = new Date(value);
    const valid = !Number.isNaN(date.getTime());
    const key = valid
      ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
      : value;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.records.push(record);
    } else {
      groups.push({ key, label: formatDayLabel(value), records: [record] });
    }
  }
  return groups;
}

/** "今天" / "昨天" / "9 月 17 日", and the year only when it is not the current one. */
export function formatDayLabel(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const date = new Date(timestamp);
  const now = new Date();
  const days = dayDifference(date, now);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  const monthDay = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return date.getFullYear() === now.getFullYear()
    ? monthDay
    : `${date.getFullYear()} 年 ${monthDay}`;
}

/** Whole days between two dates, compared by calendar day rather than by elapsed hours. */
function dayDifference(date: Date, now: Date) {
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  return Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
}

/** `HH:MM` — the clock time, since the day is already stated by the group heading. */
export function formatClockTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

/** `m:ss` — a position inside an episode, not a time of day. */
export function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
