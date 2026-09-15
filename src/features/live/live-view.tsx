import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Heart,
  Radio,
  RotateCw,
  Search,
  Tv,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { loadEpg, loadLiveCatalog } from "@/lib/live-adapter";
import {
  isTauriRuntime,
  resolvePlayback,
  type PlaybackResolution,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import type { EpgProgram, LiveChannel, LiveCatalog } from "@/types/moseek";
import { MediaPlayer, usesHlsPipeline } from "@/features/player/media-player";
import { MediaDiagnosticPanel } from "@/features/player/media-diagnostic-panel";
import type { MediaDiagnosticSnapshot } from "@/features/player/media-diagnostics";

const maxAutomaticStreamAttempts = 3;

export function LiveView() {
  const sources = useAppStore((state) => state.sources);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const liveFavorites = useAppStore((state) => state.liveFavorites);
  const toggleLiveFavorite = useAppStore((state) => state.toggleLiveFavorite);
  const liveSources = useMemo(
    () =>
      sources.filter(
        (source) => source.enabled && source.sourceType === "live",
      ),
    [sources],
  );
  const [liveSourceKey, setLiveSourceKey] = useState(liveSources[0]?.key ?? "");
  const liveSource =
    liveSources.find((source) => source.key === liveSourceKey) ??
    liveSources[0];
  const [catalog, setCatalog] = useState<LiveCatalog>({
    channels: [],
    groups: [],
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [epgPrograms, setEpgPrograms] = useState<EpgProgram[]>([]);
  const [epgError, setEpgError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [query, setQuery] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [mediaDiagnostic, setMediaDiagnostic] =
    useState<MediaDiagnosticSnapshot | null>(null);
  const [resolvedStream, setResolvedStream] =
    useState<PlaybackResolution | null>(null);
  const [streamIndex, setStreamIndex] = useState(0);
  const [showDiagnosticPanel, setShowDiagnosticPanel] = useState(false);
  const streamIndexRef = useRef(0);

  useEffect(() => {
    if (!liveSources.some((source) => source.key === liveSourceKey)) {
      setLiveSourceKey(liveSources[0]?.key ?? "");
    }
  }, [liveSourceKey, liveSources]);

  useEffect(() => {
    let cancelled = false;
    setCatalog({ channels: [], groups: [] });
    setLoadError(null);
    setEpgPrograms([]);
    setEpgError(null);
    setGroupId("");
    setSelectedChannelId("");
    setDiagnostic(null);
    setMediaDiagnostic(null);
    setResolvedStream(null);
    setIsLoading(Boolean(liveSource));
    if (!liveSource) {
      return () => {
        cancelled = true;
      };
    }
    void loadLiveCatalog(liveSource).then((result) => {
      if (cancelled) return;
      setCatalog(result.data);
      setLoadError(result.error);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [liveSource?.api, liveSource?.ext, liveSource?.key]);

  const channels = catalog.channels;
  const groups = catalog.groups;

  useEffect(() => {
    if (!groups.some((group) => group.id === groupId)) {
      setGroupId(groups[0]?.id ?? "");
    }
    if (!channels.some((channel) => channel.id === selectedChannelId)) {
      setSelectedChannelId(channels[0]?.id ?? "");
    }
  }, [channels, groupId, groups, selectedChannelId]);

  const filteredChannels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return channels.filter((channel) => {
      const matchesGroup =
        Boolean(normalizedQuery) || channel.groupId === groupId;
      const matchesQuery =
        !normalizedQuery ||
        channel.name.toLowerCase().includes(normalizedQuery);
      return matchesGroup && matchesQuery;
    });
  }, [channels, groupId, query]);

  const selectedChannel =
    channels.find((channel) => channel.id === selectedChannelId) ??
    filteredChannels[0] ??
    channels[0];
  const selectedIndex = channels.findIndex(
    (channel) => channel.id === selectedChannel?.id,
  );
  const programs = epgPrograms.filter(
    (program) =>
      program.channelId === (selectedChannel?.epgId ?? selectedChannel?.id),
  );
  const streamUrls = selectedChannel
    ? selectedChannel.streamUrls.length > 0
      ? selectedChannel.streamUrls
      : [selectedChannel.streamUrl]
    : [];
  const selectedStreamUrl =
    streamUrls[streamIndex] ?? streamUrls[0] ?? selectedChannel?.streamUrl;
  const playerUrl =
    resolvedStream?.url ?? selectedStreamUrl ?? selectedChannel?.streamUrl ?? "";
  const playerKind =
    resolvedStream?.mediaKind ?? selectedChannel?.mediaKind ?? "unknown";
  const playerPipeline = usesHlsPipeline(playerKind, true, playerUrl)
    ? "hls"
    : "native";

  useEffect(() => {
    streamIndexRef.current = 0;
    setStreamIndex(0);
  }, [selectedChannel?.id]);

  const tryNextStream = () => {
    const lastAttemptIndex =
      Math.min(streamUrls.length, maxAutomaticStreamAttempts) - 1;
    if (streamIndexRef.current >= lastAttemptIndex) return false;
    const nextIndex = streamIndexRef.current + 1;
    streamIndexRef.current = nextIndex;
    setStreamIndex(nextIndex);
    setResolvedStream(null);
    return true;
  };

  useEffect(() => {
    let cancelled = false;
    setDiagnostic(null);
    if (!selectedChannel || !selectedStreamUrl) {
      setResolvedStream(null);
      return () => {
        cancelled = true;
      };
    }
    if (!isTauriRuntime()) {
      setResolvedStream({
        url: selectedStreamUrl,
        mediaKind: selectedChannel.mediaKind,
        adapterId: "browser-preview",
      });
      return () => {
        cancelled = true;
      };
    }
    void resolvePlayback(selectedStreamUrl)
      .then((resolution) => {
        if (cancelled) return;
        setResolvedStream(resolution);
      })
      .catch((error) => {
        if (cancelled) return;
        setDiagnostic(
          error instanceof Error ? error.message : "无法解析直播地址",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [selectedChannel, selectedStreamUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!liveSource || !selectedChannel) {
      setEpgPrograms([]);
      setEpgError(null);
      return () => {
        cancelled = true;
      };
    }
    void loadEpg(liveSource, selectedChannel).then((result) => {
      if (cancelled) return;
      setEpgPrograms(result.data);
      setEpgError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [liveSource, selectedChannel]);

  const isFavorite = selectedChannel
    ? liveFavorites.includes(selectedChannel.id)
    : false;

  const selectChannel = (channel: LiveChannel) => {
    setSelectedChannelId(channel.id);
    streamIndexRef.current = 0;
    setStreamIndex(0);
    setResolvedStream(null);
    setDiagnostic(null);
  };

  const stepChannel = (direction: -1 | 1) => {
    const next = channels[selectedIndex + direction];
    if (next) {
      setGroupId(next.groupId);
      selectChannel(next);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* 48px Live Topbar */}
      <header
        className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none"
      >
        <Select
          value={liveSourceKey}
          onValueChange={(value) => {
            setLiveSourceKey(value);
            setQuery("");
          }}
          disabled={liveSources.length === 0}
        >
          <SelectTrigger size="sm" className="h-8 w-48 font-medium border-primary/25 bg-primary/5 text-foreground hover:border-primary/50">
            <SelectValue placeholder="选择直播源" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {liveSources.map((source) => (
                <SelectItem key={source.key} value={source.key}>
                  {source.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        {/* Live Channel Search */}
        <div className="relative max-w-xs flex-1">
          <Search
            className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
            data-icon="inline-start"
            aria-hidden="true"
          />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索直播频道名..."
            className="pl-8 pr-3 bg-muted/40 border-border/60"
          />
        </div>

        {/* Groups Horizontal Scroll in Topbar */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => {
                setGroupId(group.id);
                const firstInGroup = channels.find((c) => c.groupId === group.id);
                if (firstInGroup) selectChannel(firstInGroup);
              }}
              className={cn(
                "shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                group.id === groupId
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {group.name}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {channels.length} 个频道
          </span>
          {selectedChannel && (
            <Button
              type="button"
              variant={isFavorite ? "secondary" : "outline"}
              size="sm"
              className="gap-1.5"
              onClick={() => toggleLiveFavorite(selectedChannel.id)}
            >
              <Heart
                className={cn("size-3.5", isFavorite && "fill-primary text-primary")}
                data-icon="inline-start"
                aria-hidden="true"
              />
              {isFavorite ? "已收藏" : "收藏"}
            </Button>
          )}
        </div>
      </header>

      {/* Main Live Workspace: Dual-Pane (Left: Channel List, Right: Player + EPG) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Channel List (240px) */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-border/70 bg-card/20 overflow-hidden">
          <ScrollArea className="flex-1">
            <div className="p-1.5 flex flex-col gap-0.5">
              {filteredChannels.length > 0 ? (
                filteredChannels.map((channel) => {
                  const isCur = channel.id === selectedChannel?.id;
                  const isFav = liveFavorites.includes(channel.id);

                  return (
                    <button
                      key={channel.id}
                      type="button"
                      onClick={() => selectChannel(channel)}
                      className={cn(
                        "group flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs transition-colors",
                        isCur
                          ? "bg-primary/15 text-primary font-semibold border-l-2 border-primary"
                          : "text-foreground/80 hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <span className="truncate pr-2">{channel.name}</span>
                      <div className="flex items-center gap-1 shrink-0 text-muted-foreground">
                        {isFav && (
                          <Heart className="size-2.5 fill-primary text-primary" />
                        )}
                        <span className="text-[10px] opacity-70">
                          {channel.streamUrls.length > 1
                            ? `${channel.streamUrls.length}线`
                            : "标配"}
                        </span>
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="py-12 text-center text-xs text-muted-foreground">
                  暂无匹配频道
                </div>
              )}
            </div>
            <ScrollBar />
          </ScrollArea>
        </aside>

        {/* Right Main Panel: Player & Floating EPG */}
        <main className="flex flex-1 min-w-0 flex-col overflow-hidden bg-black/40">
          {/* Player Surface */}
          <div className="relative flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden">
            {selectedChannel && playerUrl ? (
              <MediaPlayer
                key={`${selectedChannel.id}:${playerPipeline}`}
                title={selectedChannel.name}
                url={playerUrl}
                kind={playerKind}
                isLive
                onDiagnostic={setMediaDiagnostic}
                onStatus={(st, msg) => {
                  if (st === "error") {
                    const hasMore = tryNextStream();
                    if (!hasMore && msg) {
                      setDiagnostic(msg);
                    }
                  }
                }}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Tv className="size-8 opacity-30" />
                <span className="text-xs">
                  {liveSources.length === 0
                    ? "请先在配置中心启用有效直播源"
                    : "请从左侧选择频道开始播放"}
                </span>
              </div>
            )}

            {/* Error or Channel Info Overlay */}
            {diagnostic && (
              <div className="absolute top-3 left-3 right-3 z-30">
                <Alert variant="destructive" className="py-2 backdrop-blur-md bg-destructive/90">
                  <CircleAlert className="size-4" data-icon="inline-start" aria-hidden="true" />
                  <AlertTitle className="text-xs">播放受阻</AlertTitle>
                  <AlertDescription className="text-xs">{diagnostic}</AlertDescription>
                </Alert>
              </div>
            )}
          </div>

          {/* Bottom Live Control & EPG Strip (44px) */}
          <div className="flex h-11 shrink-0 items-center justify-between border-t border-border/70 bg-card/60 px-4 select-none">
            <div className="flex items-center gap-3 text-xs min-w-0">
              <span className="font-semibold text-foreground truncate">
                {selectedChannel?.name || "未选中频道"}
              </span>
              <span className="text-muted-foreground">|</span>
              <div className="flex items-center gap-1.5 overflow-hidden text-muted-foreground text-xs">
                {programs.length > 0 ? (
                  <>
                    <span className="text-primary font-medium truncate">
                      当前：{programs[0]?.title}
                    </span>
                    {programs[1] && (
                      <span className="truncate hidden md:inline">
                        → 稍后：{programs[1]?.title}
                      </span>
                    )}
                  </>
                ) : (
                  <span>暂无实时节目单信息</span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {streamUrls.length > 1 && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span>线路：</span>
                  {streamUrls.map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setStreamIndex(idx)}
                      className={cn(
                        "size-6 rounded text-xs font-bold transition-colors",
                        streamIndex === idx
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted/80 hover:bg-muted text-foreground",
                      )}
                    >
                      {idx + 1}
                    </button>
                  ))}
                </div>
              )}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowDiagnosticPanel((prev) => !prev)}
              >
                {showDiagnosticPanel ? "收起诊断" : "流诊断"}
              </Button>
            </div>
          </div>

          {/* Diagnostic Panel Collapsible Drawer */}
          {showDiagnosticPanel && (
            <div className="border-t border-border/80 bg-card p-3 max-h-60 overflow-y-auto">
              <MediaDiagnosticPanel
                snapshot={mediaDiagnostic}
                note={diagnostic}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
