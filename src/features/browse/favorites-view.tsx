import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronLeft,
  Clapperboard,
  Heart,
  Play,
  Radio,
  RotateCw,
  TriangleAlert,
} from "lucide-react";

import { MediaPoster } from "@/components/media-poster";
import { PosterZoomButton } from "@/components/poster-lightbox";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MediaPlayer, type MediaStatus } from "@/features/player/media-player";
import { PlaybackDiagnostics } from "@/features/player/playback-diagnostics";
import type { MediaDiagnosticSnapshot } from "@/features/player/media-diagnostics";
import {
  episodeMediaKind,
  pickEntryEpisode,
  resolveEpisodePlayback,
  resumeSeconds,
} from "@/features/player/episode-playback";
import { useStreamProbes } from "@/features/player/use-stream-probes";
import { getVodDetail } from "@/features/browse/cms-adapter";
import { relinkFavorite } from "@/features/browse/favorite-relink";
import { useAppStore } from "@/stores/app-store";
import {
  catalogCardClassName,
  catalogCardOverlayClassName,
} from "@/lib/card-styles";
import { cn } from "@/lib/utils";
import type { ViewKey } from "@/types/moseek";
import type {
  LiveFavorite,
  MediaKind,
  SourceRecord,
  VodEpisode,
  VodFavorite,
  VodItem,
  VodPlayLine,
} from "@/types/moseek";

/**
 * The favourites page: a watch surface, not a list of links.
 *
 * It used to be a grid of posters whose only action was to navigate to 影视库, which then had to
 * find the same work again — and if the source it came from had been renamed or deleted, it
 * could not. A favourite is a promise to get back to something, so everything needed to keep that
 * promise is stored with it and played here: the work with its episodes, or the channel with all
 * of its lines.
 *
 * 影视 and 直播 are separate tabs rather than one mixed list. They are different things with
 * different affordances — one resumes an episode, the other just starts a stream — and mixing
 * them meant a grid where half the cards behaved differently from the other half.
 */
export function FavoritesView({ onNavigate }: FavoritesViewProps) {
  const favorites = useAppStore((state) => state.favorites);
  const liveFavorites = useAppStore((state) => state.liveFavorites);
  const [tab, setTab] = useState<"vod" | "live">("vod");
  const [openVodKey, setOpenVodKey] = useState<string | null>(null);
  const [openLiveKey, setOpenLiveKey] = useState<string | null>(null);

  // Opening one kind closes the other, so the page never shows two players at once.
  const openVod = (key: string) => {
    setOpenLiveKey(null);
    setOpenVodKey(key);
  };
  const openLive = (key: string) => {
    setOpenVodKey(null);
    setOpenLiveKey(key);
  };

  const openVodFavorite =
    favorites.find((favorite) => favorite.key === openVodKey) ?? null;
  const openLiveFavorite =
    liveFavorites.find((favorite) => favorite.key === openLiveKey) ?? null;

  // A favourite can be removed from the page it is open on, so the open state has to follow.
  useEffect(() => {
    if (openVodKey && !favorites.some((f) => f.key === openVodKey)) {
      setOpenVodKey(null);
    }
  }, [favorites, openVodKey]);
  useEffect(() => {
    if (openLiveKey && !liveFavorites.some((f) => f.key === openLiveKey)) {
      setOpenLiveKey(null);
    }
  }, [liveFavorites, openLiveKey]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none">
        <div className="flex items-center gap-2">
          <Heart className="size-4 fill-primary text-primary" />
          <h1 className="text-sm font-semibold tracking-tight text-foreground">
            我的收藏
          </h1>
        </div>
        {/* The switch sits on the right, where the "继续探索" button used to be. It is a scope
            control for the whole page, so it belongs with the other end-of-bar control rather
            than beside the title, where it competed with the heading. */}
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "vod" | "live")}
        >
          <TabsList>
            <TabsTrigger value="vod" className="gap-1.5">
              <Clapperboard className="size-3.5" aria-hidden="true" />
              影视
              <span className="text-muted-foreground">({favorites.length})</span>
            </TabsTrigger>
            <TabsTrigger value="live" className="gap-1.5">
              <Radio className="size-3.5" aria-hidden="true" />
              电视直播
              <span className="text-muted-foreground">
                ({liveFavorites.length})
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <div className="min-h-0 flex-1">
        {tab === "vod" ? (
          openVodFavorite ? (
            <FavoriteWatchView
              favorite={openVodFavorite}
              onBack={() => setOpenVodKey(null)}
            />
          ) : (
            <VodFavoritesGrid
              favorites={favorites}
              onOpen={openVod}
              onNavigate={onNavigate}
            />
          )
        ) : openLiveFavorite ? (
          <FavoriteLiveView
            favorite={openLiveFavorite}
            onBack={() => setOpenLiveKey(null)}
          />
        ) : (
          <LiveFavoritesGrid
            favorites={liveFavorites}
            onOpen={openLive}
            onNavigate={onNavigate}
          />
        )}
      </div>
    </div>
  );
}

interface FavoritesViewProps {
  onNavigate: (view: ViewKey) => void;
}

function VodFavoritesGrid({
  favorites,
  onOpen,
  onNavigate,
}: {
  favorites: VodFavorite[];
  onOpen: (key: string) => void;
  onNavigate: (view: "browse" | "live") => void;
}) {
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);

  if (favorites.length === 0) {
    return (
      <EmptyState
        icon={<Bookmark className="size-4 text-primary" />}
        title="还没有收藏影视"
        description="在影视库浏览时点击心形图标，影片就会汇聚在这里，并能从这里直接接着看。"
        actionLabel="浏览影视库"
        onAction={() => onNavigate("browse")}
      />
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-3 gap-3 p-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
        {favorites.map((favorite) => (
          <div
            key={favorite.key}
            className={catalogCardClassName}
            onClick={() => onOpen(favorite.key)}
          >
            <div className="relative aspect-[2/3] w-full overflow-hidden bg-muted/40">
              <MediaPoster
                src={favorite.item.poster}
                alt={`${favorite.item.name} 海报`}
                className="size-full"
                imageClassName="transition-transform duration-300 group-hover:scale-105"
              />
              <div className={catalogCardOverlayClassName}>
                <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform duration-200 group-hover:scale-110">
                  <Play className="size-4 fill-current" aria-hidden="true" />
                </span>
              </div>
              {/* Same actions as a library card, in the same corner: an image to inspect and a
                  favourite to remove. */}
              <div className="absolute top-1.5 right-1.5 z-10 flex flex-col gap-1">
                <PosterZoomButton
                  name={favorite.item.name}
                  poster={favorite.item.poster}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                />
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleFavorite(favorite.item);
                  }}
                  aria-label={`取消收藏 ${favorite.item.name}`}
                  className="flex size-7 items-center justify-center rounded-full bg-black/65 text-primary backdrop-blur-xs transition-all duration-200 hover:scale-110 hover:bg-black/80 active:scale-95"
                  title="取消收藏"
                >
                  <Heart className="size-3.5 fill-current" />
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1 p-2.5">
              <p className="truncate text-xs font-semibold text-foreground transition-colors group-hover:text-primary">
                {favorite.item.name}
              </p>
              {/* Where they left off is the single most useful thing to show: it is what makes
                  resuming a decision the user does not have to make. */}
              {favorite.progress ? (
                <p className="truncate text-[11px] text-primary/90">
                  {favorite.progress.episodeName} · 看到{" "}
                  {formatClock(favorite.progress.seconds)}
                </p>
              ) : (
                <p className="truncate text-xs text-muted-foreground">
                  {favorite.sourceName}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
      <ScrollBar />
    </ScrollArea>
  );
}

function LiveFavoritesGrid({
  favorites,
  onOpen,
  onNavigate,
}: {
  favorites: LiveFavorite[];
  onOpen: (key: string) => void;
  onNavigate: (view: "browse" | "live") => void;
}) {
  const toggleLiveFavorite = useAppStore((state) => state.toggleLiveFavorite);

  if (favorites.length === 0) {
    return (
      <EmptyState
        icon={<Bookmark className="size-4 text-primary" />}
        title="还没有收藏频道"
        description="在电视直播里点「收藏」，频道就会出现在这里，点开即可观看，不必再回直播页翻找。"
        actionLabel="前往电视直播"
        onAction={() => onNavigate("live")}
      />
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {favorites.map((favorite) => (
          <div
            key={favorite.key}
            className="group flex cursor-pointer items-center gap-3 rounded-md border border-border/60 bg-card/60 p-3 transition-colors hover:border-primary/50 hover:bg-card"
            onClick={() => onOpen(favorite.key)}
          >
            <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/50">
              {favorite.channel.logoUrl ? (
                <img
                  src={favorite.channel.logoUrl}
                  alt=""
                  className="size-full object-contain"
                  loading="lazy"
                />
              ) : (
                <Radio className="size-4 text-muted-foreground" aria-hidden="true" />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs font-semibold text-foreground group-hover:text-primary">
                {favorite.channel.name}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {favorite.channel.groupName || favorite.sourceName}
              </span>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                toggleLiveFavorite(favorite.channel, favorite.sourceName);
              }}
              className="shrink-0 rounded-full p-1 text-primary transition-transform hover:scale-110 active:scale-95"
              title="取消收藏"
            >
              <Heart className="size-3.5 fill-current" />
            </button>
          </div>
        ))}
      </div>
      <ScrollBar />
    </ScrollArea>
  );
}

/**
 * The watch surface for a favourited work.
 *
 * Layout follows the live workspace: the episode rail on the left, the player on the right. That
 * is the shape the user asked for, and it is the right one — the rail is a list you scan while
 * watching, not a decision to make before starting.
 *
 * The saved episode is played from the snapshot, so nothing has to be fetched before the picture
 * can start. The detail request only runs to refresh the episode list, because a series that has
 * been updated since it was favourited should offer the new episodes.
 */
function FavoriteWatchView({
  favorite,
  onBack,
}: {
  favorite: VodFavorite;
  onBack: () => void;
}) {
  const normalizedConfig = useAppStore((state) => state.normalizedConfig);
  const sources = useAppStore((state) => state.sources);
  const setFavoriteProgress = useAppStore((state) => state.setFavoriteProgress);
  const refreshFavorite = useAppStore((state) => state.refreshFavorite);

  const [item, setItem] = useState(favorite.item);
  // Computed once, on mount. The entry episode is a starting point, not a derived value: keying
  // it on `item` would move the user to a different episode the moment the episode list was
  // refreshed underneath them.
  const [entry] = useState(() =>
    pickEntryEpisode(favorite.item, favorite.progress),
  );
  const [activeLineId, setActiveLineId] = useState(entry.lineId);
  const [activeEpisodeId, setActiveEpisodeId] = useState(entry.episodeId);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [mediaDiagnostic, setMediaDiagnostic] =
    useState<MediaDiagnosticSnapshot | null>(null);

  const source = sources.find((candidate) => candidate.key === item.sourceKey);
  /**
   * Read through a ref so this stays stable.
   *
   * `favorite` is rebuilt by the store on every progress tick, so a callback closing over
   * `favorite.progress` would get a new identity every few seconds — and anything depending on it
   * would re-run just as often. The refresh effect depends on this callback, so an unstable one
   * would refetch the detail mid-playback on a timer.
   */
  const favoriteRef = useRef(favorite);
  favoriteRef.current = favorite;
  const setItemWithProgress = useCallback(
    (next: VodItem, nextSourceName: string) => {
      setItem(next);
      // Keep the same episode where possible. A relinked series numbers its episodes
      // independently, so the name is what carries the user's place across.
      const nextEntry = pickEntryEpisode(next, favoriteRef.current.progress);
      setActiveEpisodeId(nextEntry.episodeId);
      setRecoveryNote(
        `原源「${favoriteRef.current.sourceName}」不可用，已自动切换到「${nextSourceName}」。`,
      );
    },
    [],
  );

  /**
   * The refresh runs once per favourite, not on every store change.
   *
   * It used to depend on `favorite.item`, and to write back through `refreshFavorite` — which
   * replaces `favorite.item` in the store. The effect therefore re-triggered itself forever:
   * each pass fetched the detail again, produced a new `item`, and handed the player a new
   * `episode` object, so the player reset before it could start. That is what made the surface
   * spin on "正在准备播放" and made the picture flash and vanish. Keying on the identity of the
   * favourite, and reading the snapshot through a ref, breaks the cycle.
   */
  const snapshotRef = useRef(favorite.item);
  snapshotRef.current = favorite.item;
  useEffect(() => {
    let cancelled = false;
    // The saved source is gone, or it answered with nothing. Either way the snapshot's addresses
    // are the only thing left, and they may be stale — so look for the same work elsewhere and
    // swap it in silently. The user asked to get back to what they were watching, not to be told
    // which source to fix.
    const recover = async (reason: string) => {
      if (cancelled) return;
      setRefreshNote(`${reason}正在查找其它可用源…`);
      const relinked = await relinkFavorite(
        snapshotRef.current,
        sources,
        favorite.sourceKey,
      ).catch(() => null);
      if (cancelled) return;
      if (relinked) {
        setItemWithProgress(relinked.item, relinked.source.name);
        setRefreshNote(null);
        refreshFavorite(favorite.key, relinked.item);
      } else {
        setRefreshNote(
          `${reason}其它已启用的影视源里也没有找到这部作品，仍在使用收藏时保存的地址。`,
        );
      }
    };

    if (!source) {
      void recover(`「${favorite.sourceName}」已不在配置中。`);
      return () => {
        cancelled = true;
      };
    }
    void getVodDetail(source, snapshotRef.current).then((result) => {
      if (cancelled) return;
      if (result.data) {
        setItem(result.data);
        refreshFavorite(favorite.key, result.data);
        setRefreshNote(null);
      } else {
        void recover(
          result.error
            ? `刷新剧集信息失败（${result.error}）。`
            : "这个源没有返回剧集信息。",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    favorite.key,
    favorite.sourceKey,
    favorite.sourceName,
    refreshFavorite,
    setItemWithProgress,
    source,
    sources,
  ]);

  const activeLine =
    item.playLines.find((line) => line.id === activeLineId) ?? item.playLines[0];
  const activeEpisode =
    activeLine?.episodes.find((episode) => episode.id === activeEpisodeId) ??
    activeLine?.episodes[0];

  const selectEpisode = useCallback(
    (episode: VodEpisode) => {
      setActiveEpisodeId(episode.id);
      if (activeLine) {
        setFavoriteProgress(item.id, {
          lineId: activeLine.id,
          episodeId: episode.id,
          episodeName: episode.name,
          seconds: 0,
          episodeCount: activeLine.episodes.length,
          updatedAt: new Date().toISOString(),
        });
      }
    },
    [activeLine, item.id, setFavoriteProgress],
  );

  /**
   * Switches lines, keeping the user's place by episode name.
   *
   * Lines number their episodes independently, so carrying the id across would land on an
   * unrelated episode — the name is what identifies "the one I was watching".
   */
  const selectLine = useCallback(
    (line: VodPlayLine) => {
      setActiveLineId(line.id);
      const currentName = activeEpisode?.name;
      const sameEpisode = currentName
        ? line.episodes.find((episode) => episode.name === currentName)
        : undefined;
      const next = sameEpisode ?? line.episodes[0];
      setActiveEpisodeId(next?.id ?? "");
      setFavoriteProgress(item.id, {
        lineId: line.id,
        episodeId: next?.id ?? "",
        episodeName: next?.name ?? "",
        seconds: 0,
        episodeCount: line.episodes.length,
        updatedAt: new Date().toISOString(),
      });
    },
    [activeEpisode?.name, item.id, setFavoriteProgress],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/70 px-4 py-2">
        {/* Icon-only, matching the watch page's back button: the arrow is unambiguous, and the
            word took width from the title without adding meaning. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="返回收藏"
          title="返回收藏"
          className="text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <h2 className="truncate text-sm font-semibold text-foreground">
          {item.name}
        </h2>
        {/* The count belongs with the title it describes, not in a header bar over the rail. */}
        <span className="shrink-0 text-xs text-muted-foreground">
          共 {activeLine?.episodes.length ?? 0} 集
        </span>
        {favorite.progress && (
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            上次看到 {favorite.progress.episodeName}
          </span>
        )}

        {/* Line switching lives here, on the title row, rather than above the episode list.
            Switching a line is a decision about the whole work, not about one episode, and the
            title row is where the work's own controls belong — it also keeps the rail a single
            uninterrupted list. */}
        {item.playLines.length > 1 && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* No "线路" caption: the buttons are the only things on this row that read as a
                choice, and each one's tooltip already names it. */}
            {item.playLines.map((line, index) => {
              const isActive = line.id === activeLine?.id;
              return (
                <button
                  key={line.id}
                  type="button"
                  onClick={() => selectLine(line)}
                  aria-label={`线路 ${index + 1}：${line.name}`}
                  aria-pressed={isActive}
                  title={`${line.name}（${line.episodes.length} 集）`}
                  className={cn(
                    "rounded px-2 py-0.5 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/70 text-foreground/80 hover:bg-muted hover:text-foreground",
                  )}
                >
                  {line.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Episode rail, left. It mirrors the live workspace's channel list so the two pages read
            the same way. */}
        <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-border/70 bg-card/20">
          <ScrollArea
            type="auto"
            className="min-h-0 flex-1"
            viewportClassName="[&>div]:!block"
          >
            <div className="flex flex-col gap-0.5 p-1.5">
              {(activeLine?.episodes ?? []).map((episode) => {
                const isCurrent = episode.id === activeEpisode?.id;
                return (
                  <button
                    key={episode.id}
                    type="button"
                    onClick={() => selectEpisode(episode)}
                    aria-current={isCurrent ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors",
                      isCurrent
                        ? "border-l-2 border-primary bg-primary/15 font-semibold text-primary"
                        : "text-foreground/80 hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <Play
                      className={cn(
                        "size-3 shrink-0",
                        isCurrent ? "fill-current" : "opacity-0",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate">{episode.name}</span>
                  </button>
                );
              })}
            </div>
            <ScrollBar />
          </ScrollArea>
        </aside>

        {/* Player, right. */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-black/40">
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
            {activeEpisode ? (
              <ResolvedEpisodePlayer
                key={`${item.id}:${activeEpisode.id}`}
                source={source}
                episode={activeEpisode}
                normalizedConfig={normalizedConfig}
                title={`${item.name} · ${activeEpisode.name}`}
                resumeAt={resumeSeconds(
                  favorite.progress?.episodeId === activeEpisode.id
                    ? favorite.progress
                    : null,
                )}
                onProgress={(seconds) =>
                  setFavoriteProgress(item.id, {
                    lineId: activeLine?.id ?? "",
                    episodeId: activeEpisode.id,
                    episodeName: activeEpisode.name,
                    seconds,
                    episodeCount: activeLine?.episodes.length ?? 0,
                    updatedAt: new Date().toISOString(),
                  })
                }
                onDiagnostic={(snapshot) => {
                  // Diagnostics only exist to explain a failure, so a healthy session keeps no
                  // snapshot; the events leading up to a failure are the evidence.
                  setMediaDiagnostic(snapshot.status === "error" ? snapshot : null);
                  setDiagnostic(snapshot.message);
                }}
                onStatus={(nextStatus, message) => {
                  setStatus(nextStatus);
                  if (message) setDiagnostic(message);
                }}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 px-8 text-center">
                <TriangleAlert className="size-7 text-white/70" aria-hidden="true" />
                <p className="text-sm font-medium text-white">无法播放这个收藏</p>
                <p className="max-w-md text-xs leading-5 text-white/60">
                  收藏时保存的剧集信息里没有可用的播放地址。可以在影视库中重新找到这部作品。
                </p>
              </div>
            )}
          </div>

          {/* Status strip, matching the live workspace's: the same bar in the same place on both
              pages, so the two players read as one component. The diagnosis is an entry on this
              bar rather than an icon floating over the picture, where it covered the video and
              looked like part of the player's own controls. */}
          <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-t border-border/70 bg-card/60 px-4 select-none">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  status === "error"
                    ? "bg-destructive"
                    : status === "playing"
                      ? "bg-emerald-500"
                      : "bg-muted-foreground/60",
                )}
                aria-hidden="true"
              />
              <span className="shrink-0 text-muted-foreground">
                {status === "error"
                  ? "播放失败"
                  : status === "playing"
                    ? "正在播放"
                    : status === "paused"
                      ? "已暂停"
                      : status === "ended"
                        ? "已播完"
                        : "正在准备播放"}
              </span>
              <span className="truncate text-foreground/80">
                {activeEpisode?.name}
              </span>
              {(recoveryNote || refreshNote) && (
                <>
                  <span className="text-muted-foreground">|</span>
                  <span className="truncate text-muted-foreground">
                    {recoveryNote ?? refreshNote}
                  </span>
                </>
              )}
            </div>
            {activeEpisode && (
              <PlaybackDiagnostics
                snapshot={mediaDiagnostic}
                note={diagnostic}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Resolves an episode and hands it to the player.
 *
 * The resolution is the same one the watch page performs, through the shared
 * `resolveEpisodePlayback`, so a favourite plays exactly what the library would play.
 */
function ResolvedEpisodePlayer({
  source,
  episode,
  normalizedConfig,
  title,
  resumeAt,
  onProgress,
  onDiagnostic,
  onStatus,
}: {
  source: SourceRecord | undefined;
  episode: VodEpisode;
  normalizedConfig: string;
  title: string;
  resumeAt: number;
  onProgress: (seconds: number) => void;
  onDiagnostic: (snapshot: MediaDiagnosticSnapshot) => void;
  onStatus: (status: MediaStatus, message?: string) => void;
}) {
  const [resolved, setResolved] = useState<{
    url: string;
    mediaKind: MediaKind;
    headers: Record<string, string>;
  } | null>(null);
  /**
   * Only the address-resolution failure lives here.
   *
   * The player's own status messages used to be written to this same state, so any message —
   * including an ordinary "正在连接" — replaced the player with the failure screen. That is what
   * made playback flash: the player mounted, reported a status, was unmounted by that report, and
   * came back only when the user pressed 重试.
   */
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Keyed on the episode's identity and address rather than the object, so a refresh that
  // rebuilds the same episode list does not tear the player down and start it over.
  const episodeUrl = episode.url;
  const episodeId = episode.id;
  const episodeRef = useRef(episode);
  episodeRef.current = episode;

  useEffect(() => {
    let cancelled = false;
    setResolveError(null);
    setResolved(null);
    void resolveEpisodePlayback(source, episodeRef.current, normalizedConfig)
      .then((resolution) => {
        if (!cancelled) setResolved(resolution);
      })
      .catch((cause) => {
        if (cancelled) return;
        setResolveError(
          cause instanceof Error ? cause.message : "播放地址未通过安全检查",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, episodeId, episodeUrl, normalizedConfig, source]);

  if (resolveError) {
    return (
      <div className="flex flex-col items-center gap-3 px-8 text-center">
        <TriangleAlert className="size-7 text-white/70" aria-hidden="true" />
        <p className="text-sm font-medium text-white">无法播放当前内容</p>
        <p className="max-w-md text-xs leading-5 text-white/70">{resolveError}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setAttempt((current) => current + 1)}
        >
          <RotateCw className="size-3.5" data-icon="inline-start" aria-hidden="true" />
          重试
        </Button>
      </div>
    );
  }

  if (!resolved) {
    return (
      <div className="flex flex-col items-center gap-3" aria-live="polite">
        <span className="size-8 animate-spin rounded-full border-2 border-white/25 border-t-primary" />
        <p className="text-xs text-white/60">正在准备播放…</p>
      </div>
    );
  }

  return (
    <MediaPlayer
      title={title}
      url={resolved.url}
      kind={resolved.mediaKind || episodeMediaKind(episode)}
      headers={resolved.headers}
      fill
      resumeAt={resumeAt}
      onProgress={onProgress}
      onDiagnostic={onDiagnostic}
      onStatus={onStatus}
    />
  );
}

/** The watch surface for a favourited channel, laid out like the live workspace. */
function FavoriteLiveView({
  favorite,
  onBack,
}: {
  favorite: LiveFavorite;
  onBack: () => void;
}) {
  const channel = favorite.channel;
  const streamUrls =
    channel.streamUrls.length > 0 ? channel.streamUrls : [channel.streamUrl];
  const { probes, isProbing, streamIndex, selectStream, probeFor } =
    useStreamProbes(streamUrls, channel.id);
  const [resolved, setResolved] = useState<{ url: string; mediaKind: MediaKind } | null>(
    null,
  );
  const streamUrl = streamUrls[streamIndex] ?? streamUrls[0] ?? "";

  // The saved address plays first; the resolve step only unwraps a parser service in front of it.
  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    void resolvePlaybackSafe(streamUrl).then((resolution) => {
      if (!cancelled) setResolved(resolution);
    });
    return () => {
      cancelled = true;
    };
  }, [streamUrl]);

  const allDead = Boolean(
    probes && probes.length > 0 && probes.every((probe) => !probe.ok),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/70 px-4 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          返回收藏
        </Button>
        <h2 className="truncate text-sm font-semibold text-foreground">
          {channel.name}
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {channel.groupName || favorite.sourceName}
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
        {resolved ? (
          <MediaPlayer
            key={`${channel.id}:${streamUrl}`}
            title={channel.name}
            url={resolved.url}
            kind={resolved.mediaKind || channel.mediaKind}
            isLive
            fill
          />
        ) : (
          <div className="flex flex-col items-center gap-3" aria-live="polite">
            <span className="size-8 animate-spin rounded-full border-2 border-white/25 border-t-primary" />
            <p className="text-xs text-white/60">
              {allDead
                ? "这个频道的线路都连不上，可以试试其它线路。"
                : "正在连接直播信号…"}
            </p>
          </div>
        )}
      </div>

      <footer className="flex h-11 shrink-0 items-center justify-between gap-3 border-t border-border/70 bg-card/60 px-4 select-none">
        <span className="truncate text-xs text-muted-foreground">
          {favorite.sourceName}
        </span>
        {streamUrls.length > 1 && (
          <div className="flex items-center gap-1">
            {streamUrls.map((_, index) => {
              const probe = probeFor(index);
              const isPending = isProbing && !probe;
              const isDead = Boolean(probe && !probe.ok);
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => selectStream(index)}
                  title={
                    probe
                      ? probe.ok
                        ? `可用 · ${probe.elapsedMs} 毫秒`
                        : probe.message
                      : isPending
                        ? "正在测试"
                        : undefined
                  }
                  aria-label={
                    isPending
                      ? `线路 ${index + 1}（测试中）`
                      : probe
                        ? `线路 ${index + 1}${probe.ok ? "（可用）" : "（不可用）"}`
                        : `线路 ${index + 1}`
                  }
                  className={cn(
                    "relative size-6 rounded text-xs font-bold transition-colors",
                    streamIndex === index
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/80 text-foreground hover:bg-muted",
                    isDead && streamIndex !== index && "text-muted-foreground/40",
                  )}
                >
                  {isPending ? (
                    <span
                      className="mx-auto block size-3 animate-spin rounded-full border-2 border-current/25 border-t-current"
                      aria-hidden="true"
                    />
                  ) : (
                    index + 1
                  )}
                </button>
              );
            })}
          </div>
        )}
      </footer>
    </div>
  );
}

/**
 * Resolves a saved stream address, falling back to the address itself.
 *
 * A favourited channel was saved with addresses that were already resolved once, so a failure
 * here usually means the address simply needs no unwrapping — not that it is unusable. Reporting
 * it as a playback error would be wrong.
 */
async function resolvePlaybackSafe(url: string) {
  const { isTauriRuntime, resolvePlayback } = await import("@/lib/tauri");
  if (!isTauriRuntime()) {
    return { url, mediaKind: "hls" as MediaKind };
  }
  try {
    const resolution = await resolvePlayback(url);
    return resolution ?? { url, mediaKind: "hls" as MediaKind };
  } catch {
    return { url, mediaKind: "hls" as MediaKind };
  }
}

function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Empty className="max-w-md border-border/40 bg-card/20 py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle className="text-sm">{title}</EmptyTitle>
          <EmptyDescription className="text-xs">{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

/** `m:ss` — a position inside an episode, not a time of day. */
function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
