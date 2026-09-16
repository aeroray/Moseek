import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  ExternalLink,
  ListVideo,
  ScanSearch,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { parseParseServices } from "@/features/config/config-parser";
import { normalizeCatVodResult } from "@/features/script/catvod-normalizer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppStore } from "@/stores/app-store";
import {
  executeScriptArchive,
  isTauriRuntime,
  openExternalUrl,
  resolvePlayback,
  sniffWithCompanion,
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
import { MediaDiagnosticPanel } from "@/features/player/media-diagnostic-panel";
import type { MediaDiagnosticSnapshot } from "@/features/player/media-diagnostics";

export interface VodPlayerRequest {
  item: VodItem;
  source: SourceRecord;
  line: VodPlayLine;
  episode: VodEpisode;
}

export function PlayerView({
  request,
  onBack,
}: {
  request: VodPlayerRequest;
  onBack: () => void;
}) {
  const { item, source } = request;
  const addHistory = useAppStore((state) => state.addHistory);
  const playbackProgress = useAppStore((state) => state.playbackProgress);
  const normalizedConfig = useAppStore((state) => state.normalizedConfig);
  const snifferCompanionUrl = useAppStore((state) => state.snifferCompanionUrl);
  const setPlaybackProgress = useAppStore((state) => state.setPlaybackProgress);
  const [activeLineId, setActiveLineId] = useState(request.line.id);
  const [activeEpisodeId, setActiveEpisodeId] = useState(request.episode.id);
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [mediaDiagnostic, setMediaDiagnostic] =
    useState<MediaDiagnosticSnapshot | null>(null);
  const [isSniffing, setIsSniffing] = useState(false);
  const [resolvedPlayback, setResolvedPlayback] =
    useState<PlaybackResolution | null>(
      isTauriRuntime()
        ? null
        : {
            url: request.episode.url,
            mediaKind: inferMediaKind(request.episode.url),
            adapterId: "browser-preview",
          },
    );

  const activeLine =
    item.playLines.find((line) => line.id === activeLineId) ??
    item.playLines[0] ??
    request.line;
  const activeEpisode =
    activeLine.episodes.find((episode) => episode.id === activeEpisodeId) ??
    activeLine.episodes[0] ??
    request.episode;
  const historyId = `${item.id}:${activeEpisode.id}`;
  const resumeAt = playbackProgress[historyId] ?? 0;
  const mediaKind = inferMediaKind(activeEpisode.url);
  const activeIndex = activeLine.episodes.findIndex(
    (episode) => episode.id === activeEpisode.id,
  );

  useEffect(() => {
    let cancelled = false;
    setDiagnostic(null);
    setMediaDiagnostic(null);
    if (!isTauriRuntime()) {
      setResolvedPlayback({
        url: activeEpisode.url,
        mediaKind: inferMediaKind(activeEpisode.url),
        adapterId: "browser-preview",
      });
      return () => {
        cancelled = true;
      };
    }
    setResolvedPlayback(null);
    setStatus("loading");
    const resolveEpisode = async () => {
      let playbackUrl = activeEpisode.url;
      let playbackHeaders: Record<string, string> = {};
      if (
        source.scriptArchiveId !== null &&
        source.scriptArchiveId !== undefined &&
        !/^https?:\/\//i.test(playbackUrl)
      ) {
        const scriptResult = await executeScriptArchive(
          source.scriptArchiveId,
          { url: playbackUrl, id: activeEpisode.id },
          "parseIframe",
        );
        if (!scriptResult) throw new Error("脚本档案没有返回 parseIframe 结果");
        const normalized = normalizeCatVodResult(
          "parseIframe",
          scriptResult.value,
          { sourceKey: source.key, sourceName: source.name },
        );
        if (normalized.kind !== "playback" || !normalized.value) {
          throw new Error("parseIframe 返回值无法转换为播放地址");
        }
        playbackUrl = normalized.value.url;
        playbackHeaders = normalized.value.headers;
      }
      const resolution = await resolvePlayback(
        playbackUrl,
        parseParseServices(normalizedConfig),
      );
      if (!resolution) throw new Error("桌面运行时未返回播放解析结果");
      return { ...resolution, headers: playbackHeaders };
    };
    void resolveEpisode()
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
  }, [activeEpisode.url, normalizedConfig, source.key, source.scriptArchiveId]);

  const selectEpisode = (line: VodPlayLine, episode: VodEpisode) => {
    setActiveLineId(line.id);
    setActiveEpisodeId(episode.id);
    addHistory({
      item,
      lineId: line.id,
      episodeId: episode.id,
      episodeName: episode.name,
      progress: playbackProgress[`${item.id}:${episode.id}`] ?? 0,
    });
    setDiagnostic(null);
  };

  const stepEpisode = (direction: -1 | 1) => {
    const nextEpisode = activeLine.episodes[activeIndex + direction];
    if (nextEpisode) selectEpisode(activeLine, nextEpisode);
  };

  const handleExternalPlayer = async () => {
    try {
      await openExternalUrl(
        resolvedPlayback?.url ?? activeEpisode.url,
        parseParseServices(normalizedConfig),
      );
      setDiagnostic("已按用户操作打开外部播放地址。");
    } catch (error) {
      setDiagnostic(
        error instanceof Error ? error.message : "无法打开外部播放地址",
      );
    }
  };

  const handleLocalSniff = async () => {
    if (isSniffing || !isTauriRuntime()) return;
    setIsSniffing(true);
    setDiagnostic(null);
    setStatus("loading");
    try {
      const resolved = await sniffWithCompanion(
        activeEpisode.url,
        snifferCompanionUrl,
      );
      if (!resolved) throw new Error("桌面运行时未返回嗅探结果");
      setResolvedPlayback(resolved);
      setStatus("idle");
      setDiagnostic("本地嗅探伴侣已返回通过安全检查的播放地址。");
    } catch (error) {
      setStatus("error");
      setDiagnostic(error instanceof Error ? error.message : "本地嗅探失败");
    } finally {
      setIsSniffing(false);
    }
  };

  const displayMediaKind = resolvedPlayback?.mediaKind ?? mediaKind;
  const canRenderPlayer = !isTauriRuntime() || resolvedPlayback !== null;

  const statusDotClass =
    status === "error"
      ? "bg-destructive"
      : status === "playing"
        ? "bg-[color:var(--status-supported)]"
        : status === "loading"
          ? "animate-pulse bg-primary"
          : "bg-muted-foreground";

  return (
    // The page owns its scrolling, so the root must be a flex column with an explicit height
    // and `min-h-0` on the scrolling child. Previously the root was `h-full` while the inner
    // column was taller than the viewport, which clipped the top of the right-hand list.
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Single header row: back, title, episode stepper. The title leads with the work's name
          because the previous "播放器视窗" heading named the widget instead of the content. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-card/40 px-5 py-2.5 backdrop-blur-md select-none">
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

        <div className="mx-1 h-5 w-px shrink-0 bg-border/70" aria-hidden="true" />

        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate font-display text-sm font-bold tracking-tight text-foreground">
            {item.name}
          </h1>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{source.name}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{activeLine.name}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 font-medium text-primary">
              {activeEpisode.name}
            </span>
            <span className="shrink-0 text-muted-foreground/70">
              （{activeIndex + 1} / {activeLine.episodes.length}）
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Only surfaced when the source is not fully usable: a green "可用" badge on every
              ordinary source is noise, while a degraded one is worth knowing about. */}
          {source.capability !== "supported" && (
            <CapabilityBadge status={source.capability} />
          )}
          {/* The two auxiliary actions moved off the header into an overflow menu. They were a
              prominent pair of buttons on every playback screen even though they are rarely
              used, and they pushed the header wide on narrow windows. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="更多播放操作"
              >
                <EllipsisVertical className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                播放方式
              </DropdownMenuLabel>
              <DropdownMenuItem
                disabled={!isTauriRuntime() || isSniffing}
                onSelect={() => void handleLocalSniff()}
              >
                <ScanSearch className="size-4" aria-hidden="true" />
                {isSniffing ? "嗅探中..." : "本地嗅探"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleExternalPlayer()}>
                <ExternalLink className="size-4" aria-hidden="true" />
                用外部播放器打开
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              activeIndex < 0 || activeIndex >= activeLine.episodes.length - 1
            }
            onClick={() => stepEpisode(1)}
          >
            下一集
            <ChevronRight className="size-4" data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] gap-4 overflow-hidden p-5">
        {/* The player column scrolls on its own; the episode list is a fixed rail beside it. */}
        <ScrollArea className="min-h-0">
          <div className="flex flex-col gap-3 pr-3">
            {canRenderPlayer ? (
              <MediaPlayer
                key={resolvedPlayback?.url ?? activeEpisode.url}
                title={`${item.name} · ${activeEpisode.name}`}
                url={resolvedPlayback?.url ?? activeEpisode.url}
                kind={resolvedPlayback?.mediaKind ?? mediaKind}
                headers={resolvedPlayback?.headers}
                poster={item.poster}
                resumeAt={resumeAt}
                onProgress={(seconds) =>
                  setPlaybackProgress(historyId, seconds)
                }
                onStatus={(nextStatus, message) => {
                  setStatus(nextStatus);
                  if (message) setDiagnostic(message);
                }}
                onDiagnostic={setMediaDiagnostic}
              />
            ) : (
              <div className="flex aspect-video items-center justify-center rounded-md bg-muted text-sm text-muted-foreground">
                正在校验播放地址...
              </div>
            )}

            {diagnostic && status === "error" && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" data-icon="inline-start" aria-hidden="true" />
                <AlertTitle className="text-xs">播放失败</AlertTitle>
                <AlertDescription className="text-xs text-destructive/90">
                  {diagnostic}
                </AlertDescription>
              </Alert>
            )}

            {/* Status and diagnostics share one surface: the collapsed row is the status strip,
                and expanding reveals the detail in place instead of dumping it permanently
                below the player. */}
            <MediaDiagnosticPanel
              collapsible
              snapshot={mediaDiagnostic}
              note={diagnostic && status !== "error" ? diagnostic : null}
              summary={
                <>
                  <span className={`size-2 shrink-0 rounded-full ${statusDotClass}`} />
                  <span className="font-medium">{statusLabel(status)}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {displayMediaKind.toUpperCase()} · {formatSeconds(resumeAt)}
                  </span>
                </>
              }
            />
          </div>
          <ScrollBar />
        </ScrollArea>

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
                {item.playLines.length} 线路 · {activeLine.episodes.length} 集
              </span>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col p-0">
            <Tabs
              value={activeLine.id}
              onValueChange={(lineId) => {
                const line = item.playLines.find(
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
                {item.playLines.map((line) => (
                  <TabsTrigger key={line.id} value={line.id} className="flex-none px-3">
                    {line.name}
                  </TabsTrigger>
                ))}
              </TabsList>
              {item.playLines.map((line) => (
                <TabsContent
                  key={line.id}
                  value={line.id}
                  className="mt-0 min-h-0 flex-1"
                >
                  <ScrollArea className="h-full px-3">
                    <div className="grid grid-cols-2 gap-1.5 py-3">
                      {line.episodes.map((episode) => {
                        const isActive =
                          activeEpisode.id === episode.id &&
                          activeLine.id === line.id;
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function inferMediaKind(url: string): MediaKind {
  const normalizedUrl = url.toLowerCase();
  if (normalizedUrl.includes(".m3u8")) return "hls";
  if (normalizedUrl.includes(".mp4")) return "mp4";
  return "unknown";
}

function formatSeconds(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function statusLabel(status: MediaStatus) {
  return {
    idle: "等待播放",
    loading: "正在连接媒体",
    ready: "媒体已准备",
    playing: "正在播放",
    paused: "已暂停",
    ended: "播放结束",
    error: "播放失败",
  }[status];
}
