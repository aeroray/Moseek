import { useState } from "react";
import { Clapperboard, Footprints, Radio, Trash2 } from "lucide-react";

import { ChannelLogo } from "@/components/channel-logo";
import { ClearRecordsDialog } from "@/components/clear-records-dialog";
import { MediaPoster } from "@/components/media-poster";
import { Button } from "@/components/ui/button";
import { CollectionEmpty } from "@/features/browse/collection-empty";
import {
  Chip,
  ColumnEmpty,
  ColumnHeader,
  formatClock,
  formatClockTime,
} from "@/features/browse/columns";
import {
  DayHeading,
  TimelineRail,
  groupByDay,
} from "@/features/browse/timeline";
import { useAppStore } from "@/stores/app-store";
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
  const [clearOpen, setClearOpen] = useState(false);

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
          {/* No counts beside the title. Each column already states its own count in its heading,
              and a second pair of numbers up here only asked the reader to compare two places for
              the same fact. */}
        </div>
        {!isEmpty && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setClearOpen(true)}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            清空足迹
          </Button>
        )}
      </header>

      {/* The shared confirmation dialog, also opened by 我的收藏 and 系统设置. Keeping one copy is
          what makes "the same dialog" true rather than merely similar. */}
      <ClearRecordsDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="清空足迹"
        description="选择要清空的记录。清空后无法恢复，影视与电视直播各自独立。"
        targets={[
          { kind: "vod", label: "影视足迹", count: vodRecords.length },
          { kind: "live", label: "电视直播足迹", count: liveRecords.length },
        ]}
        onConfirm={(kinds) => {
          // One `clearHistory` call per selected kind, so the store keeps owning the rule that
          // progress is dropped with the record it belongs to — passing a combined set would need a
          // second rule here that could drift from the store's.
          for (const kind of kinds) clearHistory(kind);
          setClearOpen(false);
        }}
      />

      {/* **Each column scrolls on its own, from `lg` up.** The two lists are independent — films and
          channels — so one shared scrollbar dragged the whole page to reach the bottom of either, and
          scrolling one column carried the other's heading off screen. Below `lg` the columns stack
          into a single axis and the page keeps the scrollbar: a nested scroll region there would trap
          the wheel in whichever column the pointer happened to be over. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5 lg:overflow-hidden">
        {isEmpty ? (
          <CollectionEmpty
            icon={<Footprints className="size-4 text-primary" aria-hidden="true" />}
            title="还没有足迹"
            description="在影视库点开任意影片，或在电视直播里选择频道，这里就会按时间记下你到过的地方。"
            actionLabel="去影视库看看"
            onAction={() => onNavigate("browse")}
          />
        ) : (
          /* Two independent columns. Each keeps its own heading and its own empty state, so a
             column with nothing in it still explains itself instead of collapsing and leaving
             the page looking half-built.
             `lg:items-stretch` gives each column a definite height, which its own scroll region needs:
             a percentage height inside an auto-height row resolves to `auto` and would simply render
             the full list. `lg:min-h-0` stops that height being pushed past the page by its contents. */
          <div className="mx-auto grid w-full max-w-7xl items-start gap-x-10 gap-y-8 lg:min-h-0 lg:flex-1 lg:grid-cols-2 lg:items-stretch">
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
              // "电视直播", matching the navigation entry and the favourites tab. "电视" alone
              // left the same thing with two names in one product.
              title="电视直播"
              icon={<Radio className="size-3.5" aria-hidden="true" />}
              records={liveRecords}
              emptyHint="在电视直播里选择频道，这里就会记下你看过哪些台。"
              onNavigate={onNavigate}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** One column: a heading, a count, and its own timeline. */
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
  const groups = groupByDay(records, (record) => record.updatedAt);

  return (
    /* The role is explicit rather than relying on `<section aria-label>` alone: browsers do not
       consistently expose that as a landmark, so a query by role failed to find a column that was
       plainly on screen. An explicit role also makes the two columns navigable landmarks for
       assistive technology, which is the reason for labelling them at all. */
    <section
      role="region"
      aria-label={`${title}足迹`}
      className="flex min-w-0 flex-col lg:min-h-0"
    >
      <ColumnHeader
        tone={kind}
        icon={icon}
        title={title}
        count={records.length}
      />

      {records.length === 0 ? (
        <ColumnEmpty
          tone={kind}
          icon={icon}
          title={`还没有${title}足迹`}
          hint={emptyHint}
          actionLabel={isVod ? "去影视库看看" : "去电视直播看看"}
          onAction={() => onNavigate(isVod ? "browse" : "live")}
        />
      ) : (
        /* The heading above stays put; only the entries scroll. The negative right margin gives the
           scrollbar its own gutter so it does not sit over the timeline rail's end. */
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:-mr-2 lg:pr-2">
          <div className="flex flex-col gap-4">
            {groups.map((group, groupIndex) => (
              <div key={group.key} className="flex flex-col">
                <DayHeading label={group.label} />
                <ol className="flex flex-col">
                  {group.records.map((record, index) => (
                    <TimelineEntry
                      key={record.id}
                      record={record}
                      // "Last" means last in the column, not last in this day. Passing the group's
                      // own last index ended the rail at every day boundary, so a column with one
                      // record per day — which is exactly what the 电视直播 column holds — drew no
                      // line at all, and the two columns stopped looking like one component.
                      isLast={
                        groupIndex === groups.length - 1 &&
                        index === group.records.length - 1
                      }
                    />
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * One stop on the timeline.
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
  //
  // `playLines` is typed as required but this record was read back from localStorage, so it may
  // have been written by an older version or stored before the field was populated. Reading it
  // unguarded took the whole page down with "Cannot read properties of undefined".
  const lineName = isVod
    ? record.item.playLines?.find((line) => line.id === record.lineId)?.name
    : undefined;
  const sourceName = isVod ? record.item.sourceName : record.sourceName;
  const hasProgress = isVod && record.progress > 5;

  return (
    <li className="group/entry flex gap-3">
      <TimelineRail tone={isVod ? "vod" : "live"} isLast={isLast} />

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
              <Chip tone="live">{record.channel.groupName || "未分组"}</Chip>
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
    <ChannelLogo
      src={record.channel.logoUrl}
      name={record.channel.name}
      className="h-[4.25rem] w-12 shrink-0 rounded bg-muted/40 ring-1 ring-border/50"
      iconClassName="size-4"
    />
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
