import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Film,
  Grid2X2,
  Info,
  List,
  Play,
  Search,
  SlidersHorizontal,
  Star,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import type { CatalogViewMode, SourceRecord, ViewKey, VodItem, VodPlayLine } from "@/types/moseek";
import { getVodDetail, searchVod } from "@/features/browse/cms-adapter";

interface BrowseViewProps {
  onNavigate: (view: ViewKey) => void;
}

const pageSize = 8;

export function BrowseView({ onNavigate }: BrowseViewProps) {
  const sources = useAppStore((state) => state.sources);
  const browseSources = useMemo(
    () => sources.filter((source) => source.enabled && source.sourceType === "cms" && ["supported", "partial"].includes(source.capability)),
    [sources],
  );
  const [sourceKey, setSourceKey] = useState(browseSources[0]?.key ?? "");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<CatalogViewMode>("grid");
  const [posterShape, setPosterShape] = useState("portrait");
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof searchVod>>["data"] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedItem, setSelectedItem] = useState<VodItem | null>(null);

  const selectedSource = browseSources.find((source) => source.key === sourceKey) ?? browseSources[0];

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
    void searchVod(selectedSource, query, categoryId, page, pageSize).then((result) => {
      if (cancelled) return;
      setCatalog(result.data);
      setLoadError(result.error);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [categoryId, page, query, selectedSource]);

  if (selectedItem && selectedSource) {
    return <DetailView item={selectedItem} source={selectedSource} onBack={() => setSelectedItem(null)} />;
  }

  if (!selectedSource) {
    return (
      <ScrollArea className="h-full">
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-8">
          <Empty className="max-w-lg border border-dashed bg-card/40 py-16">
            <EmptyHeader><EmptyMedia variant="icon"><Film data-icon="inline-start" aria-hidden="true" /></EmptyMedia><EmptyTitle>还没有可浏览的 CMS 源</EmptyTitle><EmptyDescription>请先在配置中心导入普通 CMS 配置，并启用至少一个可用资源源。</EmptyDescription></EmptyHeader>
            <Button type="button" onClick={() => onNavigate("config")}>打开配置中心</Button>
          </Empty>
        </div>
        <ScrollBar />
      </ScrollArea>
    );
  }

  const categories = catalog?.categories ?? [];
  const itemCountText = catalog ? `${catalog.total} 部内容` : "正在读取目录";

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-[1520px] flex-col gap-6 px-8 py-8">
        <section className="flex items-end justify-between gap-8">
          <div>
            <div className="mb-3 flex items-center gap-2"><Badge variant="secondary" className="gap-1.5 bg-accent text-accent-foreground"><Film data-icon="inline-start" aria-hidden="true" />Phase 3</Badge><span className="text-xs text-muted-foreground">普通 CMS 浏览</span></div>
            <h1 className="font-display text-3xl font-semibold tracking-tight">影视库</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">搜索、分类、分页和查看普通 CMS 源的统一影视数据。被阻止的源不会出现在浏览入口。</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="size-2 rounded-full bg-[color:var(--status-supported)]" />{itemCountText}</div>
        </section>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Select value={sourceKey} onValueChange={(value) => { setSourceKey(value); setPage(1); }}>
              <SelectTrigger className="w-52"><SelectValue placeholder="选择资源源" /></SelectTrigger>
              <SelectContent><SelectGroup>{browseSources.map((source) => <SelectItem key={source.key} value={source.key}>{source.name}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            <form className="relative min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); setQuery(searchInput.trim()); setPage(1); }}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" data-icon="inline-start" aria-hidden="true" />
              <Input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="搜索影视名称、年份或地区" className="pl-9 pr-24" />
              <Button type="submit" size="sm" className="absolute right-1 top-1/2 -translate-y-1/2">搜索</Button>
            </form>
            <Select value={categoryId} onValueChange={(value) => { setCategoryId(value); setPage(1); }}>
              <SelectTrigger className="w-36"><SlidersHorizontal data-icon="inline-start" aria-hidden="true" /><SelectValue placeholder="分类" /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem value="all">全部分类</SelectItem>{categories.map((itemCategory) => <SelectItem key={itemCategory.id} value={itemCategory.id}>{itemCategory.name}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            <Select value={posterShape} onValueChange={setPosterShape}>
              <SelectTrigger className="w-36"><SelectValue placeholder="海报比例" /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem value="portrait">竖版海报</SelectItem><SelectItem value="wide">宽幅海报</SelectItem></SelectGroup></SelectContent>
            </Select>
            <div className="flex items-center gap-1 rounded-md border bg-muted/30 p-1">
              <Button type="button" variant={viewMode === "grid" ? "secondary" : "ghost"} size="icon-sm" aria-label="网格视图" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid2X2 data-icon="inline-start" aria-hidden="true" /></Button>
              <Button type="button" variant={viewMode === "list" ? "secondary" : "ghost"} size="icon-sm" aria-label="列表视图" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List data-icon="inline-start" aria-hidden="true" /></Button>
            </div>
          </CardContent>
        </Card>

        {loadError && <Alert variant="destructive"><CircleAlert data-icon="inline-start" aria-hidden="true" /><AlertTitle>资源请求失败</AlertTitle><AlertDescription>{loadError}。当前没有使用演示数据掩盖这个错误。</AlertDescription></Alert>}
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><CapabilityBadge status={selectedSource.capability} /><span className="text-sm text-muted-foreground">{selectedSource.capabilityNote}</span></div><span className="text-xs text-muted-foreground">{query ? `搜索：${query}` : "推荐内容"}</span></div>

        {isLoading ? <CatalogSkeleton viewMode={viewMode} posterShape={posterShape} /> : catalog?.items.length ? (viewMode === "grid" ? <div className="grid grid-cols-4 gap-4">{catalog.items.map((item) => <CatalogCard key={item.id} item={item} posterShape={posterShape} onOpen={() => setSelectedItem(item)} />)}</div> : <div className="flex flex-col gap-3">{catalog.items.map((item) => <CatalogListItem key={item.id} item={item} onOpen={() => setSelectedItem(item)} />)}</div>) : <Empty className="min-h-72 border border-dashed bg-card/40"><EmptyHeader><EmptyMedia variant="icon"><Search data-icon="inline-start" aria-hidden="true" /></EmptyMedia><EmptyTitle>没有匹配内容</EmptyTitle><EmptyDescription>尝试清除关键词或切换其它资源源。</EmptyDescription></EmptyHeader></Empty>}

        <div className="flex items-center justify-between border-t pt-4"><span className="text-xs text-muted-foreground">第 {catalog?.page ?? page} / {catalog?.pageCount ?? 1} 页</span><div className="flex items-center gap-2"><Button type="button" variant="outline" size="icon-sm" aria-label="上一页" disabled={!catalog || catalog.page <= 1 || isLoading} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft data-icon="inline-start" aria-hidden="true" /></Button><span className="min-w-16 text-center font-mono text-xs text-muted-foreground">{catalog?.page ?? page} / {catalog?.pageCount ?? 1}</span><Button type="button" variant="outline" size="icon-sm" aria-label="下一页" disabled={!catalog || catalog.page >= catalog.pageCount || isLoading} onClick={() => setPage((current) => current + 1)}><ChevronRight data-icon="inline-start" aria-hidden="true" /></Button></div></div>
      </div>
      <ScrollBar />
    </ScrollArea>
  );
}

function CatalogCard({ item, posterShape, onOpen }: { item: VodItem; posterShape: string; onOpen: () => void }) {
  const isFavorite = useAppStore((state) => state.favorites.some((favorite) => favorite.id === item.id));
  return <Card className="group overflow-hidden transition-colors hover:border-primary/50"><button type="button" className="block w-full text-left" onClick={onOpen}><div className={cn("overflow-hidden bg-muted", posterShape === "wide" ? "aspect-[16/10]" : "aspect-[2/3]")}><img src={item.poster} alt={`${item.name} 海报`} loading="lazy" className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" /></div><CardContent className="p-4"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate font-medium">{item.name}</p><p className="mt-1 truncate text-xs text-muted-foreground">{item.year} · {item.area}</p></div>{isFavorite && <Star className="shrink-0 fill-primary text-primary" data-icon="inline-end" aria-hidden="true" />}</div><div className="mt-3 flex flex-wrap gap-1.5">{item.categories.slice(0, 2).map((itemCategory) => <Badge key={itemCategory.id} variant="secondary" className="text-[10px]">{itemCategory.name}</Badge>)}</div></CardContent></button></Card>;
}

function CatalogListItem({ item, onOpen }: { item: VodItem; onOpen: () => void }) {
  return <Card className="group"><button type="button" className="flex w-full items-center gap-4 p-3 text-left" onClick={onOpen}><img src={item.poster} alt={`${item.name} 海报`} loading="lazy" className="size-16 shrink-0 rounded-md object-cover" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate font-medium">{item.name}</p><span className="text-xs text-muted-foreground">{item.year}</span></div><p className="mt-1 truncate text-sm text-muted-foreground">{item.description}</p><div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><span>{item.sourceName}</span><span>·</span><span>{item.categories.map((itemCategory) => itemCategory.name).join(" / ")}</span></div></div><ArrowRight className="text-muted-foreground transition-transform group-hover:translate-x-1" data-icon="inline-end" aria-hidden="true" /></button></Card>;
}

function CatalogSkeleton({ viewMode, posterShape }: { viewMode: CatalogViewMode; posterShape: string }) {
  if (viewMode === "list") return <div className="flex flex-col gap-3">{Array.from({ length: 5 }, (_, index) => <Card key={index} className="flex items-center gap-4 p-3"><Skeleton className="size-16 rounded-md" /><div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-3/4" /></div></Card>)}</div>;
  return <div className="grid grid-cols-4 gap-4">{Array.from({ length: 8 }, (_, index) => <Card key={index} className="overflow-hidden"><Skeleton className={cn(posterShape === "wide" ? "aspect-[16/10]" : "aspect-[2/3]")} /><CardContent className="flex flex-col gap-2 p-4"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /></CardContent></Card>)}</div>;
}

function DetailView({ item, source, onBack }: { item: VodItem; source: SourceRecord; onBack: () => void }) {
  const addHistory = useAppStore((state) => state.addHistory);
  const favorites = useAppStore((state) => state.favorites);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);
  const [detail, setDetail] = useState(item);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState(item.playLines[0]?.id ?? "");
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
    return () => { cancelled = true; };
  }, [item, source]);

  const selectedLine = detail.playLines.find((line) => line.id === selectedLineId) ?? detail.playLines[0];
  const handleEpisode = (line: VodPlayLine, episodeId: string, episodeName: string) => {
    setSelectedEpisode(episodeId);
    addHistory({ item: detail, lineId: line.id, episodeId, episodeName, progress: 0 });
  };

  return <ScrollArea className="h-full"><div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-8 py-8"><Button type="button" variant="ghost" className="w-fit gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden="true" />返回影视库</Button>{detailError && <Alert variant="destructive"><CircleAlert data-icon="inline-start" aria-hidden="true" /><AlertTitle>详情请求失败</AlertTitle><AlertDescription>{detailError}</AlertDescription></Alert>}<section className="grid grid-cols-[280px_1fr] gap-8"><div className="overflow-hidden rounded-lg border bg-muted"><img src={detail.poster} alt={`${detail.name} 海报`} className="aspect-[2/3] size-full object-cover" /></div><div className="flex flex-col gap-5"><div className="flex items-start justify-between gap-6"><div><div className="flex items-center gap-2"><Badge variant="secondary">{detail.year}</Badge><Badge variant="secondary">{detail.area}</Badge>{detail.categories.slice(0, 3).map((itemCategory) => <Badge key={itemCategory.id} variant="outline">{itemCategory.name}</Badge>)}</div><h1 className="mt-3 font-display text-4xl font-semibold tracking-tight">{detail.name}</h1><p className="mt-2 text-sm text-muted-foreground">来自 {source.name} · {detail.playLines.length} 条播放线路</p></div><Button type="button" variant={isFavorite ? "secondary" : "outline"} className="shrink-0 gap-2" onClick={() => toggleFavorite(detail)}>{isFavorite ? <Star className="fill-primary text-primary" data-icon="inline-start" aria-hidden="true" /> : <Bookmark data-icon="inline-start" aria-hidden="true" />}{isFavorite ? "已收藏" : "收藏"}</Button></div><p className="max-w-3xl text-sm leading-7 text-muted-foreground">{detail.description || "暂无简介。"}</p><div className="grid grid-cols-2 gap-4 border-y py-4 text-sm"><div><span className="text-muted-foreground">导演</span><p className="mt-1 font-medium">{detail.directors.join(" / ") || "暂无"}</p></div><div><span className="text-muted-foreground">演员</span><p className="mt-1 font-medium">{detail.actors.join(" / ") || "暂无"}</p></div></div><div className="flex items-center gap-2"><CapabilityBadge status={source.capability} /><span className="text-xs text-muted-foreground">{source.capabilityNote}</span></div></div></section><Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Play data-icon="inline-start" aria-hidden="true" />选集</CardTitle><CardDescription>点击选集会记录到播放历史，播放器将在下一阶段接入。</CardDescription></CardHeader><CardContent>{detail.playLines.length > 0 ? <Tabs value={selectedLine?.id} onValueChange={setSelectedLineId}><TabsList>{detail.playLines.map((line) => <TabsTrigger key={line.id} value={line.id}>{line.name}</TabsTrigger>)}</TabsList>{detail.playLines.map((line) => <TabsContent key={line.id} value={line.id} className="mt-5"><div className="grid grid-cols-6 gap-2">{line.episodes.map((episode) => <Button key={episode.id} type="button" variant={selectedEpisode === episode.id ? "secondary" : "outline"} className="justify-start gap-2" onClick={() => handleEpisode(line, episode.id, episode.name)}>{selectedEpisode === episode.id && <Check data-icon="inline-start" aria-hidden="true" />}{episode.name}</Button>)}</div></TabsContent>)}</Tabs> : <Empty className="min-h-40"><EmptyHeader><EmptyMedia variant="icon"><Info data-icon="inline-start" aria-hidden="true" /></EmptyMedia><EmptyTitle>暂无播放线路</EmptyTitle><EmptyDescription>该源返回了详情，但没有可用的播放选集。</EmptyDescription></EmptyHeader></Empty>}</CardContent></Card><Card className="border-[color:var(--status-adapter-border)] bg-[color:var(--status-adapter-bg)]"><CardContent className="flex items-start gap-3 p-4 text-[color:var(--status-adapter)]"><Info className="mt-0.5 shrink-0" data-icon="inline-start" aria-hidden="true" /><div><p className="font-medium">播放地址尚未交给播放器</p><p className="mt-1 text-sm opacity-80">Moseek 当前只读取普通 CMS 返回的线路信息，不自动执行远程脚本，也不会静默下载 JAR。</p></div></CardContent></Card></div><ScrollBar /></ScrollArea>;
}
