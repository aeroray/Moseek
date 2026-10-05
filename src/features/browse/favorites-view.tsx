import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronLeft,
  Clapperboard,
  Heart,
  Play,
  Radio,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { ChannelLogo } from "@/components/channel-logo";
import { ClearRecordsDialog } from "@/components/clear-records-dialog";
import { MediaPoster } from "@/components/media-poster";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
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
import { CollectionEmpty } from "@/features/browse/collection-empty";
import {
  ColumnEmpty,
  ColumnHeader,
  formatClock,
} from "@/features/browse/columns";
import { useAppStore } from "@/stores/app-store";
import {
  catalogCardClassName,
  catalogCardOverlayClassName,
  columnGridClassName,
} from "@/lib/card-styles";
import { cn, errorMessage } from "@/lib/utils";
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
 * 影视 and 电视直播 are two columns rather than two tabs, matching 足迹. A tab hides half the
 * collection behind a control and makes the counts a thing to go and check; side by side, both
 * are visible at once and the page reads the same way as the timeline it sits beside.
 */
export function FavoritesView({ onNavigate }: FavoritesViewProps) {
  const favorites = useAppStore((state) => state.favorites);
  const liveFavorites = useAppStore((state) => state.liveFavorites);
  const clearFavorites = useAppStore((state) => state.clearFavorites);
  const [openVodKey, setOpenVodKey] = useState<string | null>(null);
  const [openLiveKey, setOpenLiveKey] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

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

  // A player takes the whole page; the columns are the browsing state.
  if (openVodFavorite) {
    return (
      <FavoriteWatchView
        favorite={openVodFavorite}
        onBack={() => setOpenVodKey(null)}
      />
    );
  }
  if (openLiveFavorite) {
    return (
      <FavoriteLiveView
        favorite={openLiveFavorite}
        onBack={() => setOpenLiveKey(null)}
      />
    );
  }

  const isEmpty = favorites.length === 0 && liveFavorites.length === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none">
        <div className="flex items-center gap-2">
          <Heart className="size-4 fill-primary text-primary" />
          <h1 className="text-sm font-semibold tracking-tight text-foreground">
            我的收藏
          </h1>
        </div>
        {/* The same header action as 足迹, opening the same dialog, so the two collection pages
            are cleared the same way. Ghost-with-destructive-text rather than a filled danger
            button: this is a page-level utility, and a solid red block in the title bar would make
            deleting everything the most conspicuous thing on a page about keeping things. */}
        {!isEmpty && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setClearOpen(true)}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            清除收藏
          </Button>
        )}
      </header>

      <ClearRecordsDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="清除收藏"
        description="选择要清除的收藏。清除后无法恢复，影视与电视直播各自独立。"
        targets={[
          { kind: "vod", label: "影视收藏", count: favorites.length },
          { kind: "live", label: "电视直播收藏", count: liveFavorites.length },
        ]}
        onConfirm={(kinds) => {
          for (const kind of kinds) clearFavorites(kind);
          setClearOpen(false);
        }}
      />

      <ScrollArea
        className="min-h-0 flex-1"
        // The same Radix `display: table` wrapper as 足迹: without this the centred column
        // never centres, because the table grows to the widest row.
        viewportClassName="[&>div]:!block"
      >
        <div className="px-6 py-5">
          {isEmpty ? (
            <CollectionEmpty
              icon={<Bookmark className="size-4 text-primary" />}
              title="还没有收藏"
              description="在影视库或电视直播里点击心形图标，收藏的内容就会汇聚在这里，点开即可接着看。"
              actionLabel="浏览影视库"
              onAction={() => onNavigate("browse")}
            />
          ) : (
            <div className="mx-auto grid max-w-7xl items-start gap-x-10 gap-y-8 lg:grid-cols-2">
              <VodFavoritesColumn
                favorites={favorites}
                onOpen={openVod}
                onNavigate={onNavigate}
              />
              <LiveFavoritesColumn
                favorites={liveFavorites}
                onOpen={openLive}
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

interface FavoritesViewProps {
  onNavigate: (view: ViewKey) => void;
}

/**
 * The favourited works, as a poster grid.
 *
 * The same grid as 影视库, because this is the same task: recognising a work by its cover. A
 * horizontal row spent a whole line of height on one title and could show only a handful at once,
 * which is the wrong trade for a collection you scan.
 *
 * Only three things belong on a card: what it is, where you were, and the control that removes it.
 * The source, the line and the episode count were all on the row version and none of them help
 * you find the one you are looking for.
 *
 * Not a timeline. 足迹 is a record of what happened and its order is the information; a collection
 * has no order beyond the one you last added to, so a rail through it would promise a chronology
 * that is not there.
 */
function VodFavoritesColumn({
  favorites,
  onOpen,
  onNavigate,
}: {
  favorites: VodFavorite[];
  onOpen: (key: string) => void;
  onNavigate: (view: "browse" | "live") => void;
}) {
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);

  return (
    <section
      role="region"
      aria-label="影视收藏"
      className="@container flex min-w-0 flex-col"
    >
      <ColumnHeader
        tone="vod"
        icon={<Clapperboard className="size-3.5" aria-hidden="true" />}
        title="影视"
        count={favorites.length}
      />

      {favorites.length === 0 ? (
        <ColumnEmpty
          tone="vod"
          icon={<Clapperboard className="size-4" aria-hidden="true" />}
          title="还没有收藏影视"
          hint="在影视库浏览时点击心形图标，影片就会汇聚在这里，并能从这里直接接着看。"
          actionLabel="浏览影视库"
          onAction={() => onNavigate("browse")}
        />
      ) : (
        <div className={columnGridClassName}>
          {favorites.map((favorite) => (
            <FavoriteVodCard
              key={favorite.key}
              favorite={favorite}
              onOpen={() => onOpen(favorite.key)}
              onRemove={() => toggleFavorite(favorite.item)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One favourited work, as a poster.
 *
 * The removal control sits on the cover rather than in a text row: it acts on this artwork, and
 * putting it here is what lets the card carry nothing but a title and a position. It is revealed
 * on hover so a wall of hearts does not become the page's subject, and it stays reachable by
 * keyboard through `focus-visible`.
 */
function FavoriteVodCard({
  favorite,
  onOpen,
  onRemove,
}: {
  favorite: VodFavorite;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const seconds = favorite.progress?.seconds ?? 0;
  const hasProgress = seconds > 5;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      aria-label={`继续观看 ${favorite.item.name}`}
      className={catalogCardClassName}
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-muted/40">
        <MediaPoster
          src={favorite.item.poster}
          alt={`${favorite.item.name} 海报`}
          className="size-full"
          imageClassName="transition-transform duration-300 group-hover:scale-105"
        />

        <div className={catalogCardOverlayClassName}>
          <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform duration-200 group-hover:scale-110">
            <Play className="size-4 fill-current" aria-hidden="true" />
          </span>
        </div>

        {/* How far in, drawn across the foot of the cover. It reads as part of the artwork rather
            than as another line of text, and a bar is what answers "how much is left" — which is
            the question someone opening their favourites actually has. */}
        {hasProgress && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div
              className="h-full bg-primary"
              style={{ width: `${progressPercent(seconds)}%` }}
            />
          </div>
        )}

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          aria-label={`取消收藏 ${favorite.item.name}`}
          title="取消收藏"
          className={cn(
            "absolute top-1.5 right-1.5 z-10 flex size-7 items-center justify-center rounded-full bg-black/65 text-primary backdrop-blur-xs",
            "transition-opacity duration-200 hover:bg-black/85",
            // Hidden until hover so the grid is a wall of covers rather than of hearts, and always
            // shown to the keyboard, which has no hover to reveal it with.
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Heart className="size-3.5 fill-current" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-col gap-1 p-2.5">
        <p className="truncate text-xs font-semibold text-foreground transition-colors group-hover:text-primary">
          {favorite.item.name}
        </p>
        {/* Only the position, or a plain statement that there is none. The source and the line
            were on the row version and neither helps you find the work you are looking for. */}
        <p className="truncate text-[11px] tabular-nums text-muted-foreground">
          {favorite.progress
            ? `${favorite.progress.episodeName} · 看到 ${formatClock(seconds)}`
            : "未观看"}
        </p>
      </div>
    </div>
  );
}

/** The favourited channels, in the same grid. */
function LiveFavoritesColumn({
  favorites,
  onOpen,
  onNavigate,
}: {
  favorites: LiveFavorite[];
  onOpen: (key: string) => void;
  onNavigate: (view: "browse" | "live") => void;
}) {
  const toggleLiveFavorite = useAppStore((state) => state.toggleLiveFavorite);

  return (
    <section
      role="region"
      aria-label="电视直播收藏"
      className="@container flex min-w-0 flex-col"
    >
      <ColumnHeader
        tone="live"
        icon={<Radio className="size-3.5" aria-hidden="true" />}
        title="电视直播"
        count={favorites.length}
      />

      {favorites.length === 0 ? (
        <ColumnEmpty
          tone="live"
          icon={<Radio className="size-4" aria-hidden="true" />}
          title="还没有收藏频道"
          hint="在电视直播里点「收藏」，频道就会出现在这里，点开即可观看，不必再回直播页翻找。"
          actionLabel="前往电视直播"
          onAction={() => onNavigate("live")}
        />
      ) : (
        <div className={columnGridClassName}>
          {favorites.map((favorite) => (
            <FavoriteLiveCard
              key={favorite.key}
              favorite={favorite}
              onOpen={() => onOpen(favorite.key)}
              onRemove={() =>
                toggleLiveFavorite(favorite.channel, favorite.sourceName)
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One favourited channel, as a card in the same grid.
 *
 * A channel has no cover, so the logo sits on the same 2:3 surface in the same slot. Giving it a
 * different shape would break the grid's rhythm for the sake of an asset the source may not even
 * provide.
 */
function FavoriteLiveCard({
  favorite,
  onOpen,
  onRemove,
}: {
  favorite: LiveFavorite;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      aria-label={`观看 ${favorite.channel.name}`}
      className={catalogCardClassName}
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-muted/40">
        {/* The logo slot fills the card, so a logo that fails leaves a clean fallback instead of a
            broken-image glyph in the middle of the artwork. */}
        <ChannelLogo
          src={favorite.channel.logoUrl}
          name={favorite.channel.name}
          className="size-full p-2"
          iconClassName="size-6"
        />

        <div className={catalogCardOverlayClassName}>
          <span className="flex size-10 items-center justify-center rounded-full bg-sky-400 text-[#04121b] transition-transform duration-200 group-hover:scale-110">
            <Play className="size-4 fill-current" aria-hidden="true" />
          </span>
        </div>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          aria-label={`取消收藏 ${favorite.channel.name}`}
          title="取消收藏"
          className={cn(
            "absolute top-1.5 right-1.5 z-10 flex size-7 items-center justify-center rounded-full bg-black/65 text-primary backdrop-blur-xs",
            "transition-opacity duration-200 hover:bg-black/85",
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Heart className="size-3.5 fill-current" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-col gap-1 p-2.5">
        <p className="truncate text-xs font-semibold text-foreground transition-colors group-hover:text-sky-400">
          {favorite.channel.name}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {favorite.channel.groupName || "未分组"}
        </p>
      </div>
    </div>
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
        {/* Back carries its word, matching the watch page. The bare chevron saved width but not
            meaning: an arrow alone does not say whether it returns to the collection or leaves it.
            The accessible name now comes from the visible text, so no `aria-label` is needed. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" data-icon="inline-start" aria-hidden="true" />
          返回收藏
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
    void resolveEpisodePlayback(episodeRef.current, normalizedConfig)
      .then((resolution) => {
        if (!cancelled) setResolved(resolution);
      })
      .catch((cause) => {
        if (cancelled) return;
        setResolveError(errorMessage(cause, "播放地址未通过安全检查"));
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


