import { Clapperboard, Footprints, Radio, Trash2 } from "lucide-react";

import { MediaPoster } from "@/components/media-poster";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { useAppStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";
import type { FootprintRecord, ViewKey } from "@/types/moseek";

interface HistoryViewProps {
  onNavigate: (view: ViewKey) => void;
}

/**
 * 足迹 — where the user has been, newest first, split by what kind of thing it was.
 *
 * Read-only on purpose. An earlier version made every row a button back into the library, which
 * promised a return to the exact place and could not deliver it: the source may have been
 * deleted, or the episode renumbered, and the click landed somewhere adjacent at best. A record
 * of the past should not pretend to be a door — and so nothing here reacts to hover either, since
 * an affordance that suggests a click would be the same lie in a smaller form.
 *
 * Two columns rather than one merged list. A film and a channel are watched for different reasons
 * and at different times, and interleaving them meant scanning past rows that were never
 * candidates for what you were looking for. Side by side, each column answers its own question.
 */
export function HistoryView({ onNavigate }: HistoryViewProps) {
  const history = useAppStore((state) => state.history);
  const clearHistory = useAppStore((state) => state.clearHistory);

  // The store keeps one ordered list; each column filters it, so both stay newest-first without
  // a second sort or a second stored order that could drift.
  const vodRecords = history.filter((record) => record.kind === "vod");
  const liveRecords = history.filter((record) => record.kind === "live");
  const isEmpty = history.length === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none">
        <div className="flex items-center gap-2">
          <Footprints className="size-4 text-primary" aria-hidden="true" />
          <h1 className="text-sm font-semibold tracking-tight text-foreground">
            足迹
          </h1>
          {!isEmpty && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <span
                  className="size-1.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
                影视 {vodRecords.length}
              </span>
              <span className="text-muted-foreground/30">/</span>
              <span className="flex items-center gap-1">
                <span
                  className="size-1.5 rounded-full bg-sky-400"
                  aria-hidden="true"
                />
                直播 {liveRecords.length}
              </span>
            </span>
          )}
        </div>
        {!isEmpty && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={clearHistory}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            清空足迹
          </Button>
        )}
      </header>

      <ScrollArea
        className="min-h-0 flex-1"
        // Radix wraps the viewport's children in an inline `display: table; min-width: 100%`
        // element, which sizes to its content. That wrapper is why a centred column never
        // centres: the table grows to the widest row and pins everything to the left.
        viewportClassName="[&>div]:!block"
      >
        <div className="px-6 py-5">
          {isEmpty ? (
            <div className="flex h-96 items-center justify-center">
              <Empty className="max-w-md border-border/40 bg-card/20 py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Footprints className="size-4 text-primary" aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle className="text-sm">还没有足迹</EmptyTitle>
                  <EmptyDescription className="text-xs">
                    在影视库点开任意影片，或在电视直播里选择频道，这里就会按时间记下你到过的地方。
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button type="button" size="sm" onClick={() => onNavigate("browse")}>
                    去影视库看看
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : (
            /* Two independent columns. Each keeps its own heading and its own empty state, so a
               column with nothing in it still explains itself instead of collapsing and leaving
               the page looking half-built. */
            <div className="mx-auto grid max-w-7xl items-start gap-x-10 gap-y-8 lg:grid-cols-2">
              <TimelineColumn
                kind="vod"
                title="影视"
                icon={<Clapperboard className="size-3.5" aria-hidden="true" />}
                records={vodRecords}
                emptyHint="在影视库点开任意影片，这里就会记下你看到哪一集、用的是哪条线路。"
                onNavigate={onNavigate}
              />
              <TimelineColumn
                kind="live"
                title="电视"
                icon={<Radio className="size-3.5" aria-hidden="true" />}
                records={liveRecords}
                emptyHint="在电视直播里选择频道，这里就会记下你看过哪些台。"
                onNavigate={onNavigate}
              />
            </div>
          )}
        </div>
        <ScrollBar />
      </ScrollArea>
    </div>
  );
}

/**
 * One column: a heading, a count, and its own timeline.
 *
 * The count is on the column rather than only in the header so each side states how much it holds
 * without the reader comparing two numbers in a toolbar.
 */
function TimelineColumn({
  kind,
  title,
  icon,
  records,
  emptyHint,
  onNavigate,
}: {
  kind: "vod" | "live";
  title: string;
  icon: React.ReactNode;
  records: FootprintRecord[];
  emptyHint: string;
  onNavigate: (view: ViewKey) => void;
}) {
  const isVod = kind === "vod";
  const groups = groupByDay(records);

  return (
    /* The role is explicit rather than relying on `<section aria-label>` alone: browsers do not
       consistently expose that as a landmark, so a query by role failed to find a column that was
       plainly on screen. An explicit role also makes the two columns navigable landmarks for
       assistive technology, which is the reason for labelling them at all. */
    <section
      role="region"
      aria-label={`${title}足迹`}
      className="flex min-w-0 flex-col"
    >
      <div className="mb-3 flex items-center gap-2">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            isVod ? "bg-primary/12 text-primary" : "bg-sky-400/12 text-sky-400",
          )}
        >
          {icon}
        </span>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {records.length} 条
        </span>
        {/* A hairline filling the remaining width, so the heading reads as a section rule rather
            than as a label floating above a list. */}
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>

      {records.length === 0 ? (
        /* A column with nothing in it still has to look intentional. A dashed outline keeps the
           column's shape so the page reads as two panels, one of which happens to be empty,
           rather than as a layout that failed to fill. */
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-10 text-center">
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full",
              isVod ? "bg-primary/10 text-primary/80" : "bg-sky-400/10 text-sky-400/80",
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
          <p className="text-xs text-muted-foreground">还没有{title}足迹</p>
          <p className="max-w-xs text-xs leading-5 text-muted-foreground">
            {emptyHint}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1"
            onClick={() => onNavigate(isVod ? "browse" : "live")}
          >
            {isVod ? "去影视库看看" : "去电视直播看看"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col">
              {/* The day. Grouping by day is what makes this a timeline rather than a list with
                  dots: it answers "when" before the reader has to parse a timestamp, and it lets
                  each entry show only a clock time. */}
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                  {group.label}
                </span>
                <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
              </div>
              <ol className="flex flex-col">
                {group.records.map((record, index) => (
                  <TimelineEntry
                    key={record.id}
                    record={record}
                    isLast={index === group.records.length - 1}
                  />
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One stop on the timeline.
 *
 * The rail is a continuous line drawn behind the node rather than a border on the row, so it
 * survives rows of different heights without the spacing drifting.
 *
 * The metadata under the title is deliberately given three different weights instead of being one
 * dot-separated run. "第01集 · 线路 dyttm3u8 · 电影天堂" read as a single grey sentence even though
 * the three parts answer different questions — what part it was, which line served it, and where
 * it came from — and a flat run gives the eye nowhere to land. Episode and line are discrete
 * named things, so they are chips; the source is provenance, so it is the quietest text on the
 * row and sits at the far edge.
 */
function TimelineEntry({
  record,
  isLast,
}: {
  record: FootprintRecord;
  isLast: boolean;
}) {
  const isVod = record.kind === "vod";
  const title = isVod ? record.item.name : record.channel.name;
  // The line's display name, not its id: "dyttm3u8" is what the source calls it and what the
  // user saw in the episode rail, while the id is an internal key.
  const lineName = isVod
    ? record.item.playLines.find((line) => line.id === record.lineId)?.name
    : undefined;
  const sourceName = isVod ? record.item.sourceName : record.sourceName;
  const hasProgress = isVod && record.progress > 5;

  return (
    <li className="group/entry flex gap-3">
      {/* The rail. The last entry's line stops at its node, so the timeline ends where the
          history does rather than trailing into nothing. */}
      <div className="relative flex w-4 shrink-0 justify-center">
        {!isLast && (
          <span
            className={cn(
              "absolute top-5 bottom-[-0.5rem] w-px",
              isVod ? "bg-primary/20" : "bg-sky-400/20",
            )}
            aria-hidden="true"
          />
        )}
        {/* A two-part node: a soft halo with a solid core. A single flat dot reads as a bullet;
            the halo is what makes it read as a point on a line. */}
        <span
          className={cn(
            "relative z-10 mt-[1.15rem] flex size-2.5 shrink-0 items-center justify-center rounded-full ring-[3px] ring-background",
            isVod ? "bg-primary/25" : "bg-sky-400/25",
          )}
          aria-hidden="true"
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              isVod ? "bg-primary" : "bg-sky-400",
            )}
          />
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-start gap-3 py-2">
        <Poster record={record} />

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {/* Title row. The time is tabular and sits at the far edge so every row's right side
              lines up, which is what lets the eye skip down the column. */}
          <div className="flex items-baseline gap-3">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {title}
            </p>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatClockTime(record.updatedAt)}
            </span>
          </div>

          {isVod ? (
            <>
              {/* What it was, and how it was served. Both are chips because both are discrete
                  named things; the line carries the accent because it is the fact someone comes
                  back to check when playback misbehaved. */}
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Chip>{record.episodeName}</Chip>
                {lineName && <Chip tone="accent">线路 {lineName}</Chip>}
                <span className="ml-auto min-w-0 shrink-0 truncate pl-2 text-[11px] text-muted-foreground/90">
                  {sourceName}
                </span>
              </div>

              {/* A bar rather than only a timestamp: "看到 10:20" states a position but not how
                  far through that is, and the bar answers the question the user actually has. */}
              {hasProgress && (
                <div className="flex items-center gap-2.5">
                  <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary/70"
                      style={{ width: `${progressPercent(record.progress)}%` }}
                    />
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatClock(record.progress)}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <Chip tone="live">
                {record.channel.groupName || "未分组"}
              </Chip>
              <span className="ml-auto min-w-0 shrink-0 truncate pl-2 text-[11px] text-muted-foreground/90">
                {sourceName}
              </span>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** A small labelled token. Used for the two facts that name a discrete thing. */
function Chip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
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
 * The artwork, or a channel's logo in the same slot so both columns align.
 *
 * Takes the record rather than a pre-extracted URL so the union is narrowed here, in one place,
 * instead of every caller asserting which branch it is on.
 */
function Poster({ record }: { record: FootprintRecord }) {
  if (record.kind === "vod") {
    return (
      <MediaPoster
        src={record.item.poster}
        alt={`${record.item.name} 海报`}
        className="h-[4.25rem] w-12 shrink-0 overflow-hidden rounded ring-1 ring-border/50"
      />
    );
  }
  return (
    <span className="flex h-[4.25rem] w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/40 ring-1 ring-border/50">
      {record.channel.logoUrl ? (
        <img
          src={record.channel.logoUrl}
          alt=""
          className="size-full object-contain"
          loading="lazy"
        />
      ) : (
        <Radio className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}

interface DayGroup {
  key: string;
  label: string;
  records: FootprintRecord[];
}

/**
 * Splits an already newest-first list into consecutive days.
 *
 * Consecutive grouping is enough and avoids a second sort: the list arrives ordered, so records
 * sharing a day are already adjacent. A record with an unparseable timestamp becomes its own
 * group rather than being silently merged into the day above it.
 */
function groupByDay(records: FootprintRecord[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const record of records) {
    const date = new Date(record.updatedAt);
    const valid = !Number.isNaN(date.getTime());
    const key = valid
      ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
      : record.updatedAt;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.records.push(record);
    } else {
      groups.push({
        key,
        label: formatDayLabel(record.updatedAt),
        records: [record],
      });
    }
  }
  return groups;
}

/** "今天" / "昨天" / "9 月 17 日", and the year only when it is not the current one. */
function formatDayLabel(value: string) {
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
function formatClockTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

/**
 * How far through the episode the position is, as a percentage.
 *
 * The record stores seconds but not the episode's total length — sources rarely publish it, and a
 * guess would be worse than none. The bar is therefore scaled against a nominal episode length so
 * it communicates "early / midway / near the end" honestly rather than pretending to be exact.
 * Anything past the nominal length simply fills the bar.
 */
const NOMINAL_EPISODE_SECONDS = 45 * 60;
function progressPercent(seconds: number) {
  return Math.min(100, Math.round((seconds / NOMINAL_EPISODE_SECONDS) * 100));
}

/** `m:ss` — a position inside an episode, not a time of day. */
function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
