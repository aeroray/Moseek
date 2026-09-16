import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Film,
  Grid2X2,
  List,
  Play,
  Search,
  Star,
} from "lucide-react";

import { MediaPoster } from "@/components/media-poster";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { CatalogViewMode, ViewKey, VodItem } from "@/types/moseek";
import { searchVod } from "@/features/browse/cms-adapter";
import { isCandidateMovieSource, isMovieLibrarySource } from "@/lib/adapters";
import { PlayerView } from "@/features/player/player-view";
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

  if (selectedItem && selectedSource) {
    // Detail and playback are one page: opening a work loads its first episode straight into
    // the player, and the episode rail swaps streams without a navigation.
    return (
      <PlayerView
        item={selectedItem}
        source={selectedSource}
        onBack={() => setSelectedItem(null)}
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
      {/* 48px Unified Toolbar. Three zones: the scope controls (source + category) on the left,
          the search centred, and the view controls on the right. The outer zones are `flex-1` so
          the search is centred by layout rather than by an eyeballed margin. */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none">
        {/* Left: source + category. Both are scope controls — what is being browsed — so they
            sit together, and the category dropdown is immediately reachable from the source it
            filters. The category used to be a row of chips capped at the first eight
            categories, which both crowded the bar and hid the rest of the list. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
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

          <Select
            value={categoryId}
            onValueChange={(value) => {
              setCategoryId(value);
              setPage(1);
            }}
            disabled={categories.length === 0}
          >
            <SelectTrigger
              size="sm"
              className="h-8 w-36 shrink-0 font-medium border-border/60 bg-muted/40 text-foreground"
              aria-label="影片分类"
            >
              <SelectValue placeholder="全部分类" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部分类</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {/* Centre: search, widened to hold the width the category control gave up so the
            toolbar keeps the same visual mass and the field stays the obvious focal point. */}
        <form
          className="relative w-80 shrink-0 lg:w-[29rem]"
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

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
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
      {/* `min-h-0` is required: a flex item defaults to `min-height: auto`, so without it
          the scroll root grows to its full content height and the viewport ends up with
          nothing to scroll, leaving the parent's `overflow-hidden` to clip it. */}
      <ScrollArea className="flex-1 min-h-0">
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
          {/* The area is often absent (the list API returns no `vod_area`), and a literal
              "未知地区" reads as a broken field rather than as missing metadata. Show only
              what is actually known. */}
          {[item.area, item.sourceName].filter(Boolean).join(" · ")}
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
      {/* Enough placeholders to fill the tallest supported grid (7 columns) for three full rows,
          so the loading state has the same shape as the content that replaces it. */}
      {Array.from({ length: 21 }, (_, idx) => (
        <div key={idx} className="flex flex-col gap-2 rounded-md border border-border/40 p-1.5">
          <Skeleton className="aspect-[2/3] w-full rounded" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  );
}
