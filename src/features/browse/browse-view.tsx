import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Film,
  Grid2X2,
  List,
  Play,
  RotateCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { MediaPoster } from "@/components/media-poster";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppStore } from "@/stores/app-store";
import type {
  CatalogViewMode,
  SourceRecord,
  ViewKey,
  VodItem,
  VodPlayLine,
} from "@/types/moseek";
import { getVodDetail, searchVod } from "@/features/browse/cms-adapter";
import { isCandidateMovieSource, isMovieLibrarySource } from "@/lib/adapters";
import {
  PlayerView,
  type VodPlayerRequest,
} from "@/features/player/player-view";
import { cn } from "@/lib/utils";

interface BrowseViewProps {
  onNavigate: (view: ViewKey) => void;
}

const pageSize = 12;

export function BrowseView({ onNavigate }: BrowseViewProps) {
  const sources = useAppStore((state) => state.sources);
  const browseSources = useMemo(() => {
    const passed = sources.filter(isMovieLibrarySource);
    if (passed.length > 0) return passed;
    return sources.filter(isCandidateMovieSource);
  }, [sources]);
  const [sourceKey, setSourceKey] = useState(browseSources[0]?.key ?? "");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<CatalogViewMode>("grid");
  const [catalog, setCatalog] = useState<
    Awaited<ReturnType<typeof searchVod>>["data"] | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedItem, setSelectedItem] = useState<VodItem | null>(null);
  const [playerRequest, setPlayerRequest] = useState<VodPlayerRequest | null>(
    null,
  );

  const selectedSource =
    browseSources.find((source) => source.key === sourceKey) ??
    browseSources[0];

  useEffect(() => {
    if (!selectedSource && browseSources.length > 0) {
      setSourceKey(browseSources[0].key);
    }
  }, [browseSources, selectedSource]);

  useEffect(() => {
    if (!selectedSource) {
      setCatalog(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void searchVod(selectedSource, query, categoryId, page, pageSize).then(
      (result) => {
        if (cancelled) return;
        setCatalog(result.data);
        setLoadError(result.error);
        setIsLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [categoryId, page, query, selectedSource]);

  if (playerRequest) {
    return (
      <PlayerView
        request={playerRequest}
        onBack={() => setPlayerRequest(null)}
      />
    );
  }

  if (selectedItem && selectedSource) {
    return (
      <DetailView
        item={selectedItem}
        source={selectedSource}
        onBack={() => setSelectedItem(null)}
        onPlay={setPlayerRequest}
      />
    );
  }

  if (!selectedSource) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Empty className="max-w-md border-border/60 bg-card/60 py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Film className="size-5 text-primary" data-icon="inline-start" aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>暂无可用影视源</EmptyTitle>
            <EmptyDescription>
              请在「配置与源」中导入或启用至少一个普通 CMS 影视源。
            </EmptyDescription>
          </EmptyHeader>
          <Button type="button" onClick={() => onNavigate("config")}>
            打开配置中心
          </Button>
        </Empty>
      </div>
    );
  }

  const categories = catalog?.categories ?? [];
  const itemCountText = catalog ? `${catalog.total} 部` : "读取中";

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* 44px Unified Toolbar (回归标准 32px 控件阶梯) */}
      <header
        className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none"
      >
        {/* Source Selector */}
        <Select
          value={sourceKey}
          onValueChange={(value) => {
            setSourceKey(value);
            setPage(1);
          }}
        >
          <SelectTrigger size="sm" className="h-8 w-44 font-medium border-primary/25 bg-primary/5 text-foreground hover:border-primary/50">
            <SelectValue placeholder="选择影视源" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {browseSources.map((source) => (
                <SelectItem key={source.key} value={source.key}>
                  {source.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        {/* Global Search Bar */}
        <form
          className="relative flex-1 max-w-md"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(searchInput.trim());
            setPage(1);
          }}
        >
          <Search
            className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
            data-icon="inline-start"
            aria-hidden="true"
          />
          <Input
            size="sm"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索影片、导演、年份..."
            className="pl-8 pr-14 bg-muted/40 border-border/60 focus-visible:bg-background"
          />
          {searchInput.trim() && (
            <button
              type="submit"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10"
            >
              搜索
            </button>
          )}
        </form>

        {/* Categories Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1">
          <button
            type="button"
            onClick={() => {
              setCategoryId("all");
              setPage(1);
            }}
            className={cn(
              "shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors",
              categoryId === "all"
                ? "bg-primary text-primary-foreground font-semibold"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            全部
          </button>
          {categories.slice(0, 8).map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => {
                setCategoryId(cat.id);
                setPage(1);
              }}
              className={cn(
                "shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                categoryId === cat.id
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {cat.name}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground hidden lg:inline">
            {itemCountText}
          </span>

          {/* View Mode Toggle */}
          <div className="flex items-center rounded-md border border-border/60 bg-muted/30 p-0.5">
            <button
              type="button"
              className={cn(
                "rounded p-1.5 transition-colors",
                viewMode === "grid"
                  ? "bg-card text-primary shadow-2xs font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-label="网格"
              onClick={() => setViewMode("grid")}
            >
              <Grid2X2 className="size-3.5" data-icon="inline-start" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cn(
                "rounded p-1.5 transition-colors",
                viewMode === "list"
                  ? "bg-card text-primary shadow-2xs font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-label="列表"
              onClick={() => setViewMode("list")}
            >
              <List className="size-3.5" data-icon="inline-start" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <ScrollArea className="flex-1">
        <div className="p-4 flex flex-col gap-4">
          {loadError && (
            <Alert variant="destructive" className="py-2.5">
              <CircleAlert className="size-4" data-icon="inline-start" aria-hidden="true" />
              <AlertTitle className="text-xs">资源加载异常</AlertTitle>
              <AlertDescription className="text-xs">{loadError}</AlertDescription>
            </Alert>
          )}

          {isLoading ? (
            <CatalogSkeleton viewMode={viewMode} />
          ) : catalog?.items.length ? (
            viewMode === "grid" ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
                {catalog.items.map((item) => (
                  <CatalogCard
                    key={item.id}
                    item={item}
                    onOpen={() => setSelectedItem(item)}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {catalog.items.map((item) => (
                  <CatalogListItem
                    key={item.id}
                    item={item}
                    onOpen={() => setSelectedItem(item)}
                  />
                ))}
              </div>
            )
          ) : (
            <Empty className="min-h-64 border-border/40 bg-card/20 py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search className="size-4 text-muted-foreground" data-icon="inline-start" aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle className="text-sm">未检索到内容</EmptyTitle>
                <EmptyDescription className="text-xs">
                  尝试清除关键词或切换分类与影视源
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <ScrollBar />
      </ScrollArea>

      {/* 40px Compact Pagination Footer */}
      <footer className="flex h-10 shrink-0 items-center justify-between border-t border-border/70 bg-card/30 px-4 text-xs select-none">
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <span>
            第 {catalog?.page ?? page} / {catalog?.pageCount ?? 1} 页
          </span>
          {query && (
            <span className="text-primary font-medium">搜索：「{query}」</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!catalog || catalog.page <= 1 || isLoading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft className="size-3.5" data-icon="inline-start" aria-hidden="true" />
            上一页
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={
              !catalog || catalog.page >= catalog.pageCount || isLoading
            }
            onClick={() => setPage((current) => current + 1)}
          >
            下一页
            <ChevronRight className="size-3.5" data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </footer>
    </div>
  );
}

function CatalogCard({ item, onOpen }: { item: VodItem; onOpen: () => void }) {
  const isFavorite = useAppStore((state) =>
    state.favorites.some((favorite) => favorite.id === item.id),
  );

  return (
    <div
      onClick={onOpen}
      className="group relative flex flex-col overflow-hidden rounded-md border border-border/60 bg-card/60 transition-all duration-200 hover:-translate-y-1 hover:border-primary/50 hover:shadow-[0_4px_16px_rgba(0,0,0,0.4)] cursor-pointer"
    >
      {/* 2:3 Cinematic Poster ratio */}
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-muted/40">
        <MediaPoster
          src={item.poster}
          alt={`${item.name} 海报`}
          className="size-full"
          imageClassName="transition-transform duration-300 group-hover:scale-105"
        />

        {/* Top Badges */}
        <div className="absolute top-1.5 left-1.5 right-1.5 flex items-center justify-between pointer-events-none">
          {item.year ? (
            <span className="rounded bg-black/60 px-1.5 py-0.5 text-xs font-semibold text-white/90 backdrop-blur-xs">
              {item.year}
            </span>
          ) : <span />}
          {isFavorite && (
            <Star
              className="size-4 fill-primary text-primary filter drop-shadow"
              data-icon="inline-end"
              aria-hidden="true"
            />
          )}
        </div>

        {/* Hover Action Overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 backdrop-blur-2xs transition-opacity duration-200 group-hover:opacity-100">
          <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform duration-200 group-hover:scale-110">
            <Play className="size-4 ml-0.5 fill-current" />
          </div>
        </div>

        {/* Category badge at bottom corner */}
        {item.categories[0] && (
          <div className="absolute bottom-1.5 right-1.5 pointer-events-none">
            <span className="rounded bg-black/60 px-1.5 py-0.5 text-xs text-white/80 backdrop-blur-xs">
              {item.categories[0].name}
            </span>
          </div>
        )}
      </div>

      {/* Info Block */}
      <div className="p-2.5 flex flex-col gap-1">
        <p className="truncate text-xs font-semibold text-foreground group-hover:text-primary transition-colors">
          {item.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {item.area || "未知地区"} · {item.sourceName}
        </p>
      </div>
    </div>
  );
}

function CatalogListItem({
  item,
  onOpen,
}: {
  item: VodItem;
  onOpen: () => void;
}) {
  return (
    <div
      onClick={onOpen}
      className="group flex items-center gap-3.5 rounded-lg border border-border/60 bg-card/40 p-2.5 transition-all duration-150 hover:border-primary/40 hover:bg-card/70 cursor-pointer"
    >
      <MediaPoster
        src={item.poster}
        alt={`${item.name} 海报`}
        className="h-16 w-24 shrink-0 rounded overflow-hidden"
      />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
            {item.name}
          </p>
          {item.year && (
            <span className="text-xs text-muted-foreground">({item.year})</span>
          )}
          <Badge variant="secondary" className="text-xs py-0.5 px-2">
            {item.sourceName}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {item.description || "暂无剧集描述"}
        </p>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground group-hover:text-primary pr-2">
        <Play className="size-4 fill-current" />
      </div>
    </div>
  );
}

function CatalogSkeleton({ viewMode }: { viewMode: CatalogViewMode }) {
  if (viewMode === "list") {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, idx) => (
          <div key={idx} className="flex items-center gap-3 rounded-md border border-border/40 p-2">
            <Skeleton className="h-14 w-24 rounded" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
      {Array.from({ length: 14 }, (_, idx) => (
        <div key={idx} className="flex flex-col gap-2 rounded-md border border-border/40 p-1.5">
          <Skeleton className="aspect-[2/3] w-full rounded" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function DetailView({
  item,
  source,
  onBack,
  onPlay,
}: {
  item: VodItem;
  source: SourceRecord;
  onBack: () => void;
  onPlay: (request: VodPlayerRequest) => void;
}) {
  const addHistory = useAppStore((state) => state.addHistory);
  const favorites = useAppStore((state) => state.favorites);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);
  const [detail, setDetail] = useState(item);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState(
    item.playLines[0]?.id ?? "",
  );
  const [selectedEpisode, setSelectedEpisode] = useState<string | null>(null);
  const isFavorite = favorites.some((favorite) => favorite.id === item.id);

  useEffect(() => {
    let cancelled = false;
    void getVodDetail(source, item).then((result) => {
      if (cancelled) return;
      if (result.data) {
        setDetail(result.data);
        setSelectedLineId(result.data.playLines[0]?.id ?? "");
      }
      setDetailError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [item, source]);

  const selectedLine =
    detail.playLines.find((line) => line.id === selectedLineId) ??
    detail.playLines[0];

  const handleEpisode = (
    line: VodPlayLine,
    episodeId: string,
    episodeName: string,
  ) => {
    setSelectedEpisode(episodeId);
    addHistory({
      item: detail,
      lineId: line.id,
      episodeId,
      episodeName,
      progress: 0,
    });
    const episode = line.episodes.find(
      (candidate) => candidate.id === episodeId,
    );
    if (episode) onPlay({ item: detail, source, line, episode });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Detail Topbar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-card/40 px-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" data-icon="inline-start" aria-hidden="true" />
          返回列表
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={isFavorite ? "secondary" : "outline"}
            size="sm"
            className="gap-1.5"
            onClick={() => toggleFavorite(detail)}
          >
            <Star
              className={cn("size-4", isFavorite && "fill-primary text-primary")}
              data-icon="inline-start"
              aria-hidden="true"
            />
            {isFavorite ? "已收藏" : "加入收藏"}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl p-6 flex flex-col gap-6">
          {detailError && (
            <Alert variant="destructive" className="py-2.5">
              <CircleAlert className="size-4" data-icon="inline-start" aria-hidden="true" />
              <AlertTitle className="text-xs">详情获取异常</AlertTitle>
              <AlertDescription className="text-xs">{detailError}</AlertDescription>
            </Alert>
          )}

          {/* Hero Banner Grid */}
          <div className="grid grid-cols-[200px_1fr] gap-6 items-start">
            <div className="aspect-[2/3] w-full overflow-hidden rounded-lg border border-border/80 shadow-xl bg-card">
              <MediaPoster
                src={detail.poster}
                alt={`${detail.name} 海报`}
                className="size-full"
              />
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {detail.year && <Badge variant="secondary">{detail.year}</Badge>}
                {detail.area && <Badge variant="secondary">{detail.area}</Badge>}
                {detail.categories.slice(0, 3).map((cat) => (
                  <Badge key={cat.id} variant="outline">
                    {cat.name}
                  </Badge>
                ))}
                <span className="text-xs text-muted-foreground ml-auto">
                  来源：{source.name}
                </span>
              </div>

              <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
                {detail.name}
              </h1>

              <p className="text-xs leading-relaxed text-muted-foreground/90 line-clamp-4">
                {detail.description || "暂无剧集背景简介。"}
              </p>

              {/* Quick Play First Button */}
              {selectedLine?.episodes[0] && (
                <div className="pt-2">
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="gap-2 font-semibold shadow-md shadow-primary/20"
                    onClick={() =>
                      handleEpisode(
                        selectedLine,
                        selectedLine.episodes[0].id,
                        selectedLine.episodes[0].name,
                      )
                    }
                  >
                    <Play className="size-3.5 fill-current" />
                    立即起播：{selectedLine.episodes[0].name}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Play Lines & Episodes Picker */}
          <div className="flex flex-col gap-3 rounded-lg border border-border/80 bg-card/60 p-4">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground">
                  播放线路
                </span>
                <span className="text-xs text-muted-foreground">
                  (共 {detail.playLines.length} 条)
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {detail.playLines.map((line) => (
                  <button
                    key={line.id}
                    type="button"
                    onClick={() => setSelectedLineId(line.id)}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                      line.id === selectedLine?.id
                        ? "bg-primary text-primary-foreground font-semibold"
                        : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {line.name} ({line.episodes.length} 集)
                  </button>
                ))}
              </div>
            </div>

            {/* Episode Grid */}
            {selectedLine ? (
              <div className="pt-2">
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
                  {selectedLine.episodes.map((ep) => (
                    <button
                      key={ep.id}
                      type="button"
                      onClick={() => handleEpisode(selectedLine, ep.id, ep.name)}
                      className={cn(
                        "flex h-9 items-center justify-center rounded border text-xs font-medium transition-all hover:border-primary/60 hover:text-primary active:scale-95",
                        selectedEpisode === ep.id
                          ? "border-primary bg-primary/15 text-primary font-bold shadow-xs"
                          : "border-border/60 bg-muted/30 text-foreground/80",
                      )}
                    >
                      <span className="truncate px-1.5">{ep.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                当前源未解析出可用剧集或播放线路。
              </div>
            )}
          </div>
        </div>
        <ScrollBar />
      </ScrollArea>
    </div>
  );
}
