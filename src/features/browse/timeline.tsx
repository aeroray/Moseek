import { cn } from "@/lib/utils";

/**
 * The pieces only a timeline needs.
 *
 * The shared frame — heading, empty state, chip, clock formats — lives in `columns.tsx`, because
 * 我的收藏 uses the same frame without being a timeline. What stays here is what "timeline"
 * actually means: the rail, the day grouping, and the day heading.
 */

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
