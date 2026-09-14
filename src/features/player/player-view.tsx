import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  ListVideo,
  Play,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppStore } from "@/stores/app-store";
import {
  isTauriRuntime,
  openExternalUrl,
  resolvePlayback,
  type PlaybackResolution,
} from "@/lib/tauri";
import type {
  MediaKind,
  SourceRecord,
  VodEpisode,
  VodItem,
  VodPlayLine,
} from "@/types/moseek";
import { MediaPlayer, type MediaStatus } from "@/features/player/media-player";

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
  const setPlaybackProgress = useAppStore((state) => state.setPlaybackProgress);
  const [activeLineId, setActiveLineId] = useState(request.line.id);
  const [activeEpisodeId, setActiveEpisodeId] = useState(request.episode.id);
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
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
    void resolvePlayback(activeEpisode.url)
      .then((resolution) => {
        if (cancelled) return;
        setResolvedPlayback(resolution);
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
  }, [activeEpisode.url]);

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
      await openExternalUrl(activeEpisode.url);
      setDiagnostic("已按用户操作打开外部播放地址。");
    } catch (error) {
      setDiagnostic(
        error instanceof Error ? error.message : "无法打开外部播放地址",
      );
    }
  };

  const displayMediaKind = resolvedPlayback?.mediaKind ?? mediaKind;
  const canRenderPlayer = !isTauriRuntime() || resolvedPlayback !== null;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-[1520px] flex-col gap-5 px-8 py-8">
        <div className="flex items-center justify-between gap-6">
          <Button
            type="button"
            variant="ghost"
            className="gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            返回详情
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={handleExternalPlayer}
            >
              <ExternalLink data-icon="inline-start" aria-hidden="true" />
              外部播放器
            </Button>
            <CapabilityBadge status={source.capability} />
          </div>
        </div>

        <header className="flex items-end justify-between gap-8">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{source.name}</Badge>
              <span>·</span>
              <span>{activeLine.name}</span>
              <span>·</span>
              <span>{activeEpisode.name}</span>
            </div>
            <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
              {item.name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Plyr 控制层 · hls.js 媒体接入 · 进度记忆{" "}
              {resumeAt > 0 ? `从 ${formatSeconds(resumeAt)} 继续` : "尚未开始"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="上一集"
              disabled={activeIndex <= 0}
              onClick={() => stepEpisode(-1)}
            >
              <ChevronLeft data-icon="inline-start" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="下一集"
              disabled={
                activeIndex < 0 || activeIndex >= activeLine.episodes.length - 1
              }
              onClick={() => stepEpisode(1)}
            >
              <ChevronRight data-icon="inline-start" aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-5">
          <div className="flex flex-col gap-4">
            {canRenderPlayer ? (
              <MediaPlayer
                key={resolvedPlayback?.url ?? activeEpisode.url}
                title={`${item.name} · ${activeEpisode.name}`}
                url={resolvedPlayback?.url ?? activeEpisode.url}
                kind={resolvedPlayback?.mediaKind ?? mediaKind}
                poster={item.poster}
                resumeAt={resumeAt}
                onProgress={(seconds) =>
                  setPlaybackProgress(historyId, seconds)
                }
                onStatus={(nextStatus, message) => {
                  setStatus(nextStatus);
                  if (message) setDiagnostic(message);
                }}
              />
            ) : (
              <div className="flex aspect-video items-center justify-center rounded-md bg-muted text-sm text-muted-foreground">
                正在校验播放地址...
              </div>
            )}
            <div className="flex items-center justify-between rounded-md border bg-card px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <span
                  className={`size-2 rounded-full ${status === "error" ? "bg-destructive" : status === "playing" ? "bg-[color:var(--status-supported)]" : "bg-muted-foreground"}`}
                />
                <span>{statusLabel(status)}</span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                {displayMediaKind.toUpperCase()} · {formatSeconds(resumeAt)}
              </span>
            </div>
            {diagnostic && (
              <Alert variant={status === "error" ? "destructive" : "default"}>
                <AlertTriangle data-icon="inline-start" aria-hidden="true" />
                <AlertTitle>播放诊断</AlertTitle>
                <AlertDescription>{diagnostic}</AlertDescription>
              </Alert>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Info data-icon="inline-start" aria-hidden="true" />
                  播放边界
                </CardTitle>
                <CardDescription>
                  播放器不会执行远程脚本，也不会自动下载 JAR。
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-3 gap-3 text-xs text-muted-foreground">
                <div className="rounded-md border bg-muted/25 p-3">
                  <p>当前源</p>
                  <p className="mt-1 font-medium text-foreground">
                    {source.name}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/25 p-3">
                  <p>线路</p>
                  <p className="mt-1 font-medium text-foreground">
                    {activeLine.name}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/25 p-3">
                  <p>地址协议</p>
                  <p className="mt-1 font-medium text-foreground">
                    {displayMediaKind === "hls"
                      ? "HLS m3u8"
                      : displayMediaKind === "mp4"
                        ? "MP4"
                        : "未识别"}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="min-h-[560px]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ListVideo data-icon="inline-start" aria-hidden="true" />
                线路与选集
              </CardTitle>
              <CardDescription>
                {item.playLines.length} 条线路 · {activeLine.episodes.length}{" "}
                个选集
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
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
              >
                <TabsList className="mx-6 w-[calc(100%-3rem)]">
                  <>
                    {item.playLines.map((line) => (
                      <TabsTrigger key={line.id} value={line.id}>
                        {line.name}
                      </TabsTrigger>
                    ))}
                  </>
                </TabsList>
                {item.playLines.map((line) => (
                  <TabsContent key={line.id} value={line.id} className="mt-0">
                    <ScrollArea className="h-[430px] px-6">
                      <div className="grid grid-cols-2 gap-2 py-4">
                        {line.episodes.map((episode) => (
                          <Button
                            key={episode.id}
                            type="button"
                            variant={
                              activeEpisode.id === episode.id &&
                              activeLine.id === line.id
                                ? "secondary"
                                : "outline"
                            }
                            className="justify-start gap-2"
                            onClick={() => selectEpisode(line, episode)}
                          >
                            <Play data-icon="inline-start" aria-hidden="true" />
                            {episode.name}
                          </Button>
                        ))}
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
      <ScrollBar />
    </ScrollArea>
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
