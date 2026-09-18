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
 * of the past should not pretend to be a door.
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
            <span className="text-xs text-muted-foreground">
              (影视 {vodRecords.length} · 直播 {liveRecords.length})
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
        <div className="p-4">
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
            <div className="mx-auto grid max-w-7xl items-start gap-x-8 gap-y-6 lg:grid-cols-2">
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
      <div className="mb-1 flex items-center gap-2 border-b border-border/60 pb-2">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            isVod ? "bg-primary/15 text-primary" : "bg-sky-400/15 text-sky-400",
          )}
        >
          {icon}
        </span>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{records.length} 条</span>
      </div>

      {records.length === 0 ? (
        /* A column with nothing in it still has to look intentional. A dashed outline keeps the
           column's shape so the page reads as two panels, one of which happens to be empty,
           rather than as a layout that failed to fill. */
        <div className="mt-3 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-10 text-center">
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full",
              isVod ? "bg-primary/10 text-primary/70" : "bg-sky-400/10 text-sky-400/70",
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
          <p className="text-xs text-muted-foreground">还没有{title}足迹</p>
          <p className="max-w-xs text-xs leading-5 text-muted-foreground/70">
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
        <ol className="flex flex-col">
          {records.map((record, index) => (
            <TimelineEntry
              key={record.id}
              record={record}
              isLast={index === records.length - 1}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * One stop on the timeline.
 *
 * The rail is drawn with a border on a fixed-width column rather than with a list marker, so the
 * line runs continuously through the dots and the spacing stays even whatever the row's height.
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

  return (
    <li className="flex gap-3">
      {/* The rail. The last entry's line stops at its dot, so the timeline ends where the
          history does rather than trailing into nothing. */}
      <div className="relative flex w-4 shrink-0 justify-center">
        {!isLast && (
          <span
            className="absolute top-6 bottom-0 w-px bg-border"
            aria-hidden="true"
          />
        )}
        <span
          className={cn(
            "relative z-10 mt-4 flex size-2.5 shrink-0 rounded-full ring-4 ring-background",
            isVod ? "bg-primary" : "bg-sky-400",
          )}
          aria-hidden="true"
        />
      </div>

      <div className="flex min-w-0 flex-1 items-start gap-3 border-b border-border/40 py-3">
        {isVod ? (
          <MediaPoster
            src={record.item.poster}
            alt={`${record.item.name} 海报`}
            className="h-[4.5rem] w-12 shrink-0 overflow-hidden rounded"
          />
        ) : (
          <span className="flex h-[4.5rem] w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/50">
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
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{title}</p>
            {/* No kind badge. The column heading already says whether this is 影视 or 电视, and a
                label repeated on every row is noise that the grouping made unnecessary. */}
            {/* The time sits at the end of the title row, so the right edge of every entry
                carries the same kind of information and the column does not read as ragged. */}
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground/70">
              {formatFootprintTime(record.updatedAt)}
            </span>
          </div>

          {isVod ? (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="truncate">{record.episodeName}</span>
                {/* The line is worth naming: it is what the user picked in the rail, and knowing
                    which one played is the difference between "it worked" and "it worked on
                    线路二", which is exactly what someone comes back to check. */}
                {lineName && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="truncate">线路 {lineName}</span>
                  </>
                )}
                <span className="text-muted-foreground/40">·</span>
                <span className="truncate">{record.item.sourceName}</span>
              </div>

              {/* A bar rather than only a timestamp: "看到 10:20" states a position but not how
                  far through that is, and the bar answers the question the user actually has. */}
              {record.progress > 5 && (
                <div className="flex items-center gap-2">
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="truncate">
                {record.channel.groupName || "未分组"}
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className="truncate">{record.sourceName}</span>
            </div>
          )}
        </div>
      </div>
    </li>
  );
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

/**
 * A date for anything older than today, a clock time for anything today.
 *
 * A relative string ("3 小时前") was tried and is worse here: a timeline is scanned by position,
 * and "3 小时前" next to "2 小时前" makes the reader do subtraction that a timestamp does not.
 * The day is still grouped, so the ordering is obvious without arithmetic.
 */
function formatFootprintTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
  if (sameDay) return `今天 ${time}`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
}
