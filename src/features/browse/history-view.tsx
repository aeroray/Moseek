import { Footprints, Radio, Trash2 } from "lucide-react";

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
 * 足迹 — where the user has been, newest first.
 *
 * Read-only on purpose. An earlier version made every row a button back into the library, which
 * promised a return to the exact place and could not deliver it: the source may have been
 * deleted, or the episode renumbered, and the click landed somewhere adjacent at best. A record
 * of the past should not pretend to be a door.
 *
 * A timeline rather than a grid because the order is the information. A grid says "these are
 * things"; a column with times says "this is when", which is what a history is actually for.
 */
export function HistoryView({ onNavigate }: HistoryViewProps) {
  const history = useAppStore((state) => state.history);
  const clearHistory = useAppStore((state) => state.clearHistory);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none">
        <div className="flex items-center gap-2">
          <Footprints className="size-4 text-primary" aria-hidden="true" />
          <h1 className="text-sm font-semibold tracking-tight text-foreground">
            足迹
          </h1>
          <span className="text-xs text-muted-foreground">
            ({history.length} 条记录)
          </span>
        </div>
        {history.length > 0 && (
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
        // element, which sizes to its content. That wrapper was why the centred column never
        // centred: the table grew to the widest row and pinned everything to the left, leaving
        // the right half of the page empty.
        viewportClassName="[&>div]:!block"
      >
        <div className="p-4">
          {history.length === 0 ? (
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
            /* Two columns once there is room. A single narrow column pinned to the left made the
               page read as unfinished rather than as deliberately margined, and a timeline is a
               list — it can use the width it is given. */
            <div className="mx-auto grid max-w-6xl gap-x-8 lg:grid-cols-2">
              {history.map((record, index) => (
                <TimelineEntry
                  key={record.id}
                  record={record}
                  isLast={index === history.length - 1}
                />
              ))}
            </div>
          )}
        </div>
        <ScrollBar />
      </ScrollArea>
    </div>
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
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
                isVod
                  ? "bg-primary/15 text-primary"
                  : "bg-sky-400/15 text-sky-400",
              )}
            >
              {isVod ? "影视" : "直播"}
            </span>
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
