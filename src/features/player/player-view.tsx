import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ListVideo,
  ScrollText,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppStore } from "@/stores/app-store";
import {
  executeScriptArchive,
  isTauriRuntime,
  resolvePlayback,
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
  const setPlaybackProgress = useAppStore((state) => state.setPlaybackProgress);
  const [activeLineId, setActiveLineId] = useState(request.line.id);
  const [activeEpisodeId, setActiveEpisodeId] = useState(request.episode.id);
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [mediaDiagnostic, setMediaDiagnostic] =
    useState<MediaDiagnosticSnapshot | null>(null);
  const [isDiagnosticOpen, setIsDiagnosticOpen] = useState(false);
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

  const canRenderPlayer = !isTauriRuntime() || resolvedPlayback !== null;

  return (
    // The page owns its scrolling, so the root must be a flex column with an explicit height
    // and `min-h-0` on the scrolling child. Previously the root was `h-full` while the inner
    // column was taller than the viewport, which clipped the top of the right-hand list.
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Single header row: back and the work's name. The episode stepper moved below the
          player, and the source/line/episode sub-line was dropped because the same facts are
          already visible in the episode rail and the player itself. */}
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

        <div className="mx-1 h-5 w-px shrink-0 bg-border/70" aria-hidden="true" />

        <h1 className="min-w-0 flex-1 truncate font-display text-sm font-bold tracking-tight text-foreground">
          {item.name}
        </h1>

        {/* Only surfaced when the source is not fully usable: a green "可用" badge on every
            ordinary source is noise, while a degraded one is worth knowing about. */}
        {source.capability !== "supported" && (
          <div className="flex shrink-0 items-center gap-2">
            <CapabilityBadge status={source.capability} />
          </div>
        )}
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
            ) : (
              <div className="flex aspect-video items-center justify-center rounded-md bg-muted text-sm text-muted-foreground">
                正在校验播放地址...
              </div>
            )}

            {/* A failed episode states why on the player surface already; this repeats it in
                full width so the reason is readable without hovering the overlay. */}
            {diagnostic && status === "error" && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" data-icon="inline-start" aria-hidden="true" />
                <AlertTitle className="text-xs">播放失败</AlertTitle>
                <AlertDescription className="text-xs text-destructive/90">
                  {diagnostic}
                </AlertDescription>
              </Alert>
            )}

            {/* The episode stepper owns the row under the player, where the removed status
                strip used to sit. It stays visible while an episode is playing, so stepping
                never requires reaching back up to the header. */}
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
                    activeIndex < 0 ||
                    activeIndex >= activeLine.episodes.length - 1
                  }
                  onClick={() => stepEpisode(1)}
                >
                  下一集
                  <ChevronRight className="size-4" data-icon="inline-end" aria-hidden="true" />
                </Button>
              </div>

              {/* Diagnostics are only reachable when there is something to diagnose. A healthy
                  playback keeps no timeline worth reading, so the entry point stays hidden and
                  a failure is what opens the door. */}
              {status === "error" && (
                <Dialog
                  open={isDiagnosticOpen}
                  onOpenChange={setIsDiagnosticOpen}
                >
                  <DialogTrigger asChild>
                    <Button type="button" variant="outline" size="sm">
                      <ScrollText className="size-3.5" data-icon="inline-start" aria-hidden="true" />
                      播放诊断
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
                    {/* The panel carries the visible heading and the copy action, so the
                        dialog's own title exists only to name the dialog for assistive
                        technology rather than duplicating the heading on screen. */}
                    <DialogHeader className="sr-only">
                      <DialogTitle>播放诊断</DialogTitle>
                      <DialogDescription>
                        播放失败时复制这段内容，可直接定位到具体环节
                      </DialogDescription>
                    </DialogHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <MediaDiagnosticPanel
                        // The dialog already supplies the surface, so the panel drops its own
                        // card chrome instead of drawing a border inside a border.
                        className="border-0 bg-transparent backdrop-blur-none"
                        snapshot={mediaDiagnostic}
                        note={diagnostic}
                      />
                    </div>
                  </DialogContent>
                </Dialog>
              )}
            </div>
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
