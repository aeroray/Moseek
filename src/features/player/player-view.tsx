import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Heart,
  ListVideo,
  Loader2,
  Play,
  TriangleAlert,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { MediaPoster } from "@/components/media-poster";
import { PosterZoomButton } from "@/components/poster-lightbox";
import { getVodDetail } from "@/features/browse/cms-adapter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app-store";
import { inferMediaKind } from "@/lib/media-kind";
import { isFavoriteItem } from "@/lib/favorite-key";
import {
  isTauriRuntime,
  type PlaybackResolution,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type {
  MediaKind,
  SourceRecord,
  VodEpisode,
  VodItem,
  VodPlayLine,
} from "@/types/moseek";
import { MediaPlayer, type MediaStatus } from "@/features/player/media-player";
import { PlaybackDiagnostics } from "@/features/player/playback-diagnostics";
import { resolveEpisodePlayback } from "@/features/player/episode-playback";
import type { MediaDiagnosticSnapshot } from "@/features/player/media-diagnostics";

/**
 * The watch page: detail and playback on one surface.
 *
 * Detail and playback used to be two pages, so watching anything meant opening the work, then
 * leaving that page for a separate player page — and every episode switch stayed on the player
 * page, away from the metadata. Both are the same task, so they share one page: the first
 * episode of the first line is loaded on entry, and picking any other episode in the rail
 * swaps the stream in place without a navigation.
 */
export function PlayerView({
  item,
  source,
  onBack,
}: {
  item: VodItem;
  source: SourceRecord;
  onBack: () => void;
}) {
  const addVodFootprint = useAppStore((state) => state.addVodFootprint);
  const favorites = useAppStore((state) => state.favorites);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);
  const playbackProgress = useAppStore((state) => state.playbackProgress);
  const normalizedConfig = useAppStore((state) => state.normalizedConfig);
  const setPlaybackProgress = useAppStore((state) => state.setPlaybackProgress);
  const setFavoriteProgress = useAppStore((state) => state.setFavoriteProgress);

  // The catalog row already carries play lines, so this starts from the item and is replaced
  // when the detail request returns a fuller record.
  const [detail, setDetail] = useState(item);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Empty means "not chosen yet", and the derived values below fall back to the first line and
  // its first episode. That is what makes the player ready on entry without an extra effect:
  // when the detail request replaces the play lines, the fallback picks up the new first
  // episode automatically.
  const [activeLineId, setActiveLineId] = useState("");
  const [activeEpisodeId, setActiveEpisodeId] = useState("");
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [mediaDiagnostic, setMediaDiagnostic] =
    useState<MediaDiagnosticSnapshot | null>(null);
  const [resolvedPlayback, setResolvedPlayback] =
    useState<PlaybackResolution | null>(null);
  /**
   * Whether the current episode has proven it can actually play.
   *
   * The player surface stays hidden behind a loading state until this flips. Plyr builds its DOM
   * and reports "ready" before any media is fetched, so revealing the player at that point shows
   * a working-looking surface for a URL that may fail seconds later — which reads to the user as
   * "this should play" followed by an unexplained failure.
   */
  const [isPlayable, setIsPlayable] = useState(false);
  /** Bumped to force a fresh player instance when the user retries a failed episode. */
  const [retryToken, setRetryToken] = useState(0);
  const [hasMoreDescription, setHasMoreDescription] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);

  // Re-measure whenever the synopsis changes or the window resizes: the clamp's overflow depends
  // on the rendered width, so a resize can turn a fitting synopsis into an overflowing one.
  useEffect(() => {
    const measure = () =>
      setHasMoreDescription(descriptionOverflows(descriptionRef.current));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [detail.description]);

  useEffect(() => {
    let cancelled = false;
    void getVodDetail(source, item).then((result) => {
      if (cancelled) return;
      if (result.data) setDetail(result.data);
      setDetailError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [item, source]);

  const activeLine =
    detail.playLines.find((line) => line.id === activeLineId) ??
    detail.playLines[0];
  const activeEpisode =
    activeLine?.episodes.find((episode) => episode.id === activeEpisodeId) ??
    activeLine?.episodes[0];
  const activeIndex = activeLine && activeEpisode
    ? activeLine.episodes.findIndex((episode) => episode.id === activeEpisode.id)
    : -1;
  const historyId = activeEpisode ? `${detail.id}:${activeEpisode.id}` : "";
  const resumeAt = historyId ? (playbackProgress[historyId] ?? 0) : 0;
  const mediaKind = activeEpisode
    ? inferMediaKind(activeEpisode.url)
    : ("unknown" as MediaKind);
  const isFavorite = isFavoriteItem(favorites, item);
  // The resolve effect keys off these primitives rather than the episode object. The detail
  // request replaces the play lines with fresh objects for the same episodes, so an object
  // dependency would re-run the effect on arrival, blank the player and resolve the same URL
  // twice — a visible flash on entry and a restarted stream.
  const episodeUrl = activeEpisode?.url ?? "";
  const episodeId = activeEpisode?.id ?? "";

  useEffect(() => {
    if (!episodeUrl) {
      setResolvedPlayback(null);
      return;
    }
    let cancelled = false;
    setDiagnostic(null);
    setMediaDiagnostic(null);
    // A new episode has to prove itself again.
    setIsPlayable(false);
    if (!isTauriRuntime()) {
      setResolvedPlayback({
        url: episodeUrl,
        mediaKind: inferMediaKind(episodeUrl),
        adapterId: "browser-preview",
      });
      return () => {
        cancelled = true;
      };
    }
    setResolvedPlayback(null);
    setStatus("loading");
    void resolveEpisodePlayback(source, activeEpisode, normalizedConfig)
      .then((resolution) => {
        if (!cancelled) setResolvedPlayback(resolution);
      })
      .catch((error) => {
        if (cancelled) return;
        setDiagnostic(
          error instanceof Error ? error.message : "播放地址未通过安全检查",
        );
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [episodeUrl, episodeId, normalizedConfig, source.key, source.scriptArchiveId]);

  const selectEpisode = (line: VodPlayLine, episode: VodEpisode) => {
    setActiveLineId(line.id);
    setActiveEpisodeId(episode.id);
    addVodFootprint({
      item: detail,
      lineId: line.id,
      episodeId: episode.id,
      episodeName: episode.name,
      progress: playbackProgress[`${detail.id}:${episode.id}`] ?? 0,
    });
    setDiagnostic(null);
  };

  const stepEpisode = (direction: -1 | 1) => {
    if (!activeLine || activeIndex < 0) return;
    const nextEpisode = activeLine.episodes[activeIndex + direction];
    if (nextEpisode) selectEpisode(activeLine, nextEpisode);
  };

  /**
   * Records the footprint on entry, not only when an episode is picked.
   *
   * This is the fix for the empty timeline: `selectEpisode` runs only when the user actively
   * switches episodes, so opening a film and watching it through left no record at all. The entry
   * episode is what is playing, so it is what gets recorded.
   *
   * Guarded on the episode id so the arrival of the detail request — which rebuilds the play
   * lines with new objects for the same episodes — does not record the same thing twice.
   */
  const recordedRef = useRef("");
  useEffect(() => {
    if (!activeEpisode || !activeLine) return;
    const key = `${detail.id}:${activeEpisode.id}`;
    if (recordedRef.current === key) return;
    recordedRef.current = key;
    addVodFootprint({
      item: detail,
      lineId: activeLine.id,
      episodeId: activeEpisode.id,
      episodeName: activeEpisode.name,
      progress: playbackProgress[key] ?? 0,
    });
  }, [activeEpisode, activeLine, addVodFootprint, detail, playbackProgress]);

  const canRenderPlayer =
    Boolean(activeEpisode) &&
    (!isTauriRuntime() || resolvedPlayback !== null);

  return (
    // The page owns its scrolling, so the root must be a flex column with an explicit height
    // and `min-h-0` on the scrolling child. Without it the inner column grows past the
    // viewport, the rail's top is clipped, and the list has nothing left to scroll.
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-card/40 px-5 py-2.5 backdrop-blur-md select-none">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="返回列表"
          title="返回列表"
          className="text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>

        {/* The work's name leads the metadata block under the player instead of sitting here, so
            the eye lands on the work itself rather than on a toolbar. This spacer keeps the
            favourite control pinned right. No divider follows the back button: with nothing
            between them, a separator was a line drawn against empty space. */}
        <div className="min-w-0 flex-1" />

        <div className="flex shrink-0 items-center gap-2">
          {/* Only surfaced when the source is not fully usable: a green "可用" badge on every
              ordinary source is noise, while a degraded one is worth knowing about. */}
          {source.capability !== "supported" && (
            <CapabilityBadge status={source.capability} />
          )}
          <Button
            type="button"
            variant={isFavorite ? "secondary" : "outline"}
            size="sm"
            className="gap-1.5"
            onClick={() => toggleFavorite(detail)}
          >
            <Heart
              className={cn("size-3.5", isFavorite && "fill-primary text-primary")}
              data-icon="inline-start"
              aria-hidden="true"
            />
            {isFavorite ? "已收藏" : "收藏"}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] gap-4 overflow-hidden p-5">
        {/* The player column. It is a plain flex column rather than a ScrollArea: Radix's
            viewport wraps its children in a `display: table` element, so a percentage height on
            the child cannot resolve and the player collapsed to its intrinsic 150px. As a flex
            column the player takes the leftover height (`fill`), the stepper and metadata keep
            their natural size, and the page never scrolls. */}
        <div className="flex min-h-0 flex-col gap-3 pr-3">
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {!activeEpisode ? (
              /* Nothing to play: the source returned no lines or episodes. A dashed placeholder
                 fills the surface instead of a small grey box floating in a large empty area. */
              <Empty className="size-full border-border/60 bg-card/20">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ListVideo className="size-5 text-muted-foreground" aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle className="text-base">暂无可播放的剧集</EmptyTitle>
                  <EmptyDescription className="text-xs">
                    当前源未解析出播放线路或剧集。可以换一个影视源，或稍后重试。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : status === "error" ? (
              /* The failure takes the surface. The player below still mounts (hidden) so the
                 diagnostic timeline keeps recording, but the user sees the reason, not a
                 black rectangle that looks like a broken player.
                 This branch must precede the loading one: a failure to resolve the address also
                 clears `resolvedPlayback`, which makes `canRenderPlayer` false — so a loading
                 branch checked first would swallow the error and spin forever. */
              <div className="flex size-full flex-col items-center justify-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-6 text-center">
                <TriangleAlert className="size-6 text-destructive" aria-hidden="true" />
                <p className="text-sm font-medium text-destructive">无法播放当前内容</p>
                <p className="max-w-md text-xs leading-5 text-muted-foreground">
                  {diagnostic ?? "上游播放地址可能已失效或拒绝访问。"}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // Re-resolving the same URL is the cheapest real retry: it re-runs the
                    // policy check and rebuilds the pipeline from scratch.
                    setResolvedPlayback(null);
                    setIsPlayable(false);
                    setStatus("loading");
                    setDiagnostic(null);
                    setMediaDiagnostic(null);
                    setRetryToken((token) => token + 1);
                  }}
                >
                  重试
                </Button>
              </div>
            ) : !canRenderPlayer || !isPlayable ? (
              /* The surface stays a loading placeholder until the media element reports it can
                 actually play. Plyr is mounted underneath throughout so it can do its work, but
                 it is invisible and inert until then. */
              <div
                className="flex size-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/60 bg-black/40 text-center"
                aria-live="polite"
              >
                <Loader2
                  className="size-6 animate-spin text-primary"
                  aria-hidden="true"
                />
                <p className="text-xs text-muted-foreground">
                  {canRenderPlayer ? "正在确认可以播放…" : "正在校验播放地址…"}
                </p>
                <p className="max-w-sm text-xs text-muted-foreground/70">
                  {detail.name}
                  {activeEpisode ? ` · ${activeEpisode.name}` : ""}
                </p>
              </div>
            ) : null}

            {/* The player is always mounted once an episode exists, so the diagnostic timeline
                keeps recording through the loading and failure states. It is hidden rather than
                unmounted: tearing it down would discard the evidence a failure report needs. */}
            {activeEpisode && canRenderPlayer && (
              <div
                className={cn(
                  "size-full",
                  (!isPlayable || status === "error") && "hidden",
                )}
              >
                <MediaPlayer
                  key={`${resolvedPlayback?.url ?? activeEpisode.url}:${retryToken}`}
                  title={`${detail.name} · ${activeEpisode.name}`}
                  url={resolvedPlayback?.url ?? activeEpisode.url}
                  kind={resolvedPlayback?.mediaKind ?? mediaKind}
                  fill
                  headers={resolvedPlayback?.headers}
                  poster={detail.poster}
                  resumeAt={resumeAt}
                  onPlayable={() => setIsPlayable(true)}
                  onProgress={(seconds) => {
                    setPlaybackProgress(historyId, seconds);
                    // Keep the favourite's own record in step. Watching from the library and
                    // watching from 我的收藏 are the same activity, so leaving the library path
                    // out would make a favourite resume from wherever it was last opened *from
                    // the favourites page* — which is not what "where I left off" means.
                    if (isFavorite) {
                      setFavoriteProgress(detail.id, {
                        lineId: activeLine?.id ?? "",
                        episodeId: activeEpisode.id,
                        episodeName: activeEpisode.name,
                        seconds,
                        episodeCount: activeLine?.episodes.length ?? 0,
                        updatedAt: new Date().toISOString(),
                      });
                    }
                  }}
                  onStatus={(nextStatus, message) => {
                    setStatus(nextStatus);
                    if (message) setDiagnostic(message);
                  }}
                  onDiagnostic={(snapshot) =>
                    // Diagnostics only exist to explain a failure, so a healthy session keeps no
                    // snapshot at all. `MediaPlayer` still buffers its event ring internally —
                    // the events leading up to a failure are the evidence — but the page only
                    // retains a report once there is something to report.
                    setMediaDiagnostic(
                      snapshot.status === "error" ? snapshot : null,
                    )
                  }
                />
              </div>
            )}
            </div>

            {/* The stepper owns the row under the player. Diagnostics are only reachable when
                there is something to diagnose: a healthy playback keeps no timeline worth
                reading, so the entry point stays hidden and a failure opens the door. */}
            {activeEpisode && (
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={activeIndex <= 0}
                    onClick={() => stepEpisode(-1)}
                  >
                    <ChevronLeft className="size-4" data-icon="inline-start" aria-hidden="true" />
                    上一集
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      !activeLine ||
                      activeIndex < 0 ||
                      activeIndex >= activeLine.episodes.length - 1
                    }
                    onClick={() => stepEpisode(1)}
                  >
                    下一集
                    <ChevronRight className="size-4" data-icon="inline-end" aria-hidden="true" />
                  </Button>
                </div>

                {status === "error" && (
                  <PlaybackDiagnostics
                    snapshot={mediaDiagnostic}
                    note={diagnostic}
                  />
                )}
              </div>
            )}

            {/* Detail enrichment failed, but the catalog row still supplies playable lines, so
                this is a quiet note rather than a banner: playback is unaffected. */}
            {detailError && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <TriangleAlert
                  className="mt-0.5 size-3.5 shrink-0 text-destructive/80"
                  aria-hidden="true"
                />
                详情信息获取失败，已使用列表数据：{detailError}
              </p>
            )}

            {/* The work's own metadata, kept below the player rather than on a page of its own.
                It is flat: a card inside the player column would be a container around text that
                already has a separator.
                The title leads this block rather than the toolbar, because the work is what the
                page is about — a heading parked in a toolbar reads as chrome. The description is
                line-clamped so a long synopsis cannot grow the column into a scrollbar. */}
            <div className="flex gap-4 border-t border-border/60 pt-4">
              <div className="group/poster relative aspect-[2/3] w-28 shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted/40">
                <MediaPoster
                  src={detail.poster}
                  alt={`${detail.name} 海报`}
                  className="size-full"
                />
                {/* The poster is metadata on this page, so the viewer is an action on the artwork
                    itself rather than a control in the toolbar — it appears on hover, where the
                    user's attention already is when they are looking at the image. */}
                {detail.poster?.trim() && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity duration-200 group-hover/poster:opacity-100 focus-within:opacity-100">
                    <PosterZoomButton
                      name={detail.name}
                      poster={detail.poster}
                      className="size-8 bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                    />
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <h1 className="font-display text-xl font-bold tracking-tight text-balance text-foreground">
                  {detail.name}
                </h1>
                <div className="flex flex-wrap items-center gap-1.5">
                  {detail.year && <Badge variant="secondary">{detail.year}</Badge>}
                  {detail.area && <Badge variant="secondary">{detail.area}</Badge>}
                  {detail.categories.slice(0, 3).map((category) => (
                    <Badge key={category.id} variant="outline">
                      {category.name}
                    </Badge>
                  ))}
                </div>
                {/* The synopsis is clamped so a long one cannot push the page into scrolling, and
                    hovering reveals the whole text so the clamp hides nothing the user cannot get
                    back. A tooltip only earns its keep when there is genuinely more text than
                    fits, so a synopsis that already fits renders as a plain paragraph.
                    The trigger element is rendered in every case and only its class and content
                    vary: swapping the wrapper around the measured node would remount it, and the
                    re-measurement effect — keyed on the text — would not run again. */}
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p
                        ref={descriptionRef}
                        tabIndex={hasMoreDescription ? 0 : undefined}
                        className={cn(
                          "line-clamp-3 text-xs leading-relaxed text-muted-foreground/90",
                          hasMoreDescription && "cursor-help",
                        )}
                      >
                        {detail.description || "暂无剧集背景简介。"}
                      </p>
                    </TooltipTrigger>
                    {hasMoreDescription && (
                      <TooltipContent
                        side="top"
                        align="start"
                        sideOffset={6}
                        className="max-h-[min(60vh,24rem)] max-w-md overflow-y-auto text-xs leading-relaxed"
                      >
                        {detail.description}
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
                <span className="text-xs text-muted-foreground">
                  来源：{source.name}
                </span>
              </div>
            </div>
        </div>

        {/* Episode rail. It fills the available height rather than a hard-coded 560px, which
            left a large empty gap under short lists and clipped taller ones. */}
        <Card className="flex min-h-0 flex-col gap-0 overflow-hidden py-0">
          <CardHeader className="shrink-0 border-b border-border/60 py-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ListVideo className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                线路与选集
              </CardTitle>
              <span className="shrink-0 text-xs text-muted-foreground">
                {detail.playLines.length} 线路 · {activeLine?.episodes.length ?? 0} 集
              </span>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col p-0">
            {detail.playLines.length === 0 ? (
              /* An empty rail used to be a blank card, which reads as "still loading" rather
                 than "this source gave us nothing". */
              <div className="flex flex-1 items-center justify-center px-4">
                <div className="flex flex-col items-center gap-2 text-center">
                  <ListVideo
                    className="size-6 text-muted-foreground/40"
                    aria-hidden="true"
                  />
                  <p className="text-xs font-medium text-muted-foreground">
                    没有可用线路
                  </p>
                  <p className="text-xs leading-5 text-muted-foreground/70">
                    当前源没有返回播放线路或剧集。
                    <br />
                    换一个影视源，或稍后重试。
                  </p>
                </div>
              </div>
            ) : (
            <Tabs
              value={activeLine?.id ?? ""}
              onValueChange={(lineId) => {
                const line = detail.playLines.find(
                  (candidate) => candidate.id === lineId,
                );
                if (line) {
                  setActiveLineId(line.id);
                  setActiveEpisodeId(line.episodes[0]?.id ?? "");
                }
              }}
              className="min-h-0 flex-1 gap-0"
            >
              <TabsList
                variant="line"
                className="mx-3 w-[calc(100%-1.5rem)] shrink-0 justify-start overflow-x-auto"
              >
                {detail.playLines.map((line) => (
                  <TabsTrigger key={line.id} value={line.id} className="flex-none px-3">
                    {line.name}
                  </TabsTrigger>
                ))}
              </TabsList>
              {detail.playLines.map((line) => (
                <TabsContent
                  key={line.id}
                  value={line.id}
                  className="mt-0 min-h-0 flex-1"
                >
                  <ScrollArea className="h-full px-3">
                    <div className="grid grid-cols-2 gap-1.5 py-3">
                      {line.episodes.map((episode) => {
                        const isActive =
                          activeEpisode?.id === episode.id &&
                          activeLine?.id === line.id;
                        return (
                          <Button
                            key={episode.id}
                            type="button"
                            variant={isActive ? "default" : "ghost"}
                            size="sm"
                            className={cn(
                              "justify-start gap-1.5 font-normal",
                              !isActive &&
                                "bg-muted/40 text-foreground/85 hover:bg-muted hover:text-foreground",
                              isActive && "font-semibold",
                            )}
                            aria-current={isActive ? "true" : undefined}
                            onClick={() => selectEpisode(line, episode)}
                          >
                            <Play
                              className={cn(
                                "size-3 shrink-0",
                                isActive ? "fill-current" : "opacity-0",
                              )}
                              aria-hidden="true"
                            />
                            <span className="truncate">{episode.name}</span>
                          </Button>
                        );
                      })}
                    </div>
                    <ScrollBar />
                  </ScrollArea>
                </TabsContent>
              ))}
            </Tabs>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Whether the clamped synopsis actually has more text than it shows.
 *
 * Measured rather than guessed: comparing `scrollHeight` against `clientHeight` on the clamped
 * element is the only test that is correct at every width, font, and text length. A character
 * count was tried first and was wrong in both directions — it attached a pointless tooltip to
 * 130 characters of CJK that fit in three lines, and would miss a narrow window where 140
 * characters overflow.
 *
 * The fallback matters for jsdom, which performs no layout and reports every element as
 * zero-height: without it the comparison would always say "no overflow" and the tooltip would
 * never be exercised in tests. `scrollHeight > 0` distinguishes a real measurement from that.
 */
export function descriptionOverflows(element: HTMLParagraphElement | null) {
  if (!element) return false;
  if (element.scrollHeight <= 0) return true;
  return element.scrollHeight > element.clientHeight + 1;
}
