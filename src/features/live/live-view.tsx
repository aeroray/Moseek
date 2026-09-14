import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Heart,
  Radio,
  Search,
  Tv,
} from "lucide-react";

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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { loadEpg, loadLiveCatalog } from "@/lib/live-adapter";
import { cn } from "@/lib/utils";
import {
  mockEpgPrograms,
  mockLiveChannels,
  mockLiveGroups,
} from "@/lib/mock-live-data";
import { useAppStore } from "@/stores/app-store";
import type { EpgProgram, LiveChannel, LiveCatalog } from "@/types/moseek";
import { MediaPlayer } from "@/features/player/media-player";
import type { MediaStatus } from "@/features/player/media-player";

export function LiveView() {
  const sources = useAppStore((state) => state.sources);
  const liveFavorites = useAppStore((state) => state.liveFavorites);
  const toggleLiveFavorite = useAppStore((state) => state.toggleLiveFavorite);
  const liveSources = useMemo(
    () =>
      sources.filter(
        (source) => source.enabled && source.sourceType === "live",
      ),
    [sources],
  );
  const liveSource = liveSources[0];
  const [catalog, setCatalog] = useState<LiveCatalog>({
    channels: mockLiveChannels,
    groups: mockLiveGroups,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [epgPrograms, setEpgPrograms] = useState<EpgProgram[]>(mockEpgPrograms);
  const [epgError, setEpgError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [groupId, setGroupId] = useState(mockLiveGroups[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState(
    mockLiveChannels[0]?.id ?? "",
  );
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [diagnostic, setDiagnostic] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
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

  useEffect(() => {
    let cancelled = false;
    void loadEpg(liveSource).then((result) => {
      if (cancelled) return;
      setEpgPrograms(result.data.programs);
      setEpgError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [liveSource?.epg]);

  const selectChannel = (channel: LiveChannel) => {
    setSelectedChannelId(channel.id);
    setDiagnostic(null);
    setStatus("idle");
  };

  const stepChannel = (direction: -1 | 1) => {
    const next = channels[selectedIndex + direction];
    if (next) {
      setGroupId(next.groupId);
      selectChannel(next);
    }
  };

  if (!selectedChannel) {
    return <EmptyLiveState />;
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-[1520px] flex-col gap-6 px-8 py-8">
        <section className="flex items-end justify-between gap-8">
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Badge
                variant="secondary"
                className="gap-1.5 bg-accent text-accent-foreground"
              >
                <Radio data-icon="inline-start" aria-hidden="true" />
                Phase 4
              </Badge>
              <span className="text-xs text-muted-foreground">直播与 EPG</span>
            </div>
            <h1 className="font-display text-3xl font-semibold tracking-tight">
              直播
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              频道、台标和节目单集中在一个工作区。切台和收藏状态保存在本机。
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-[color:var(--status-supported)]" />
            {channels.length} 个频道 · {groups.length} 个分组
          </div>
        </section>

        {(loadError || epgError) && (
          <Alert variant="destructive">
            <CircleAlert data-icon="inline-start" aria-hidden="true" />
            <AlertTitle>直播数据请求失败</AlertTitle>
            <AlertDescription>
              {loadError ?? epgError}。当前显示可用的本地演示数据。
            </AlertDescription>
          </Alert>
        )}
        {isLoading && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/25 px-4 py-3 text-sm text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-primary" />
            正在读取直播频道目录...
          </div>
        )}

        <div className="grid grid-cols-[250px_minmax(0,1fr)_340px] gap-5">
          <Card className="min-h-[640px]">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Tv data-icon="inline-start" aria-hidden="true" />
                频道分组
              </CardTitle>
              <CardDescription>选择频道组</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 p-3">
              {groups.map((group) => (
                <Button
                  key={group.id}
                  type="button"
                  variant={group.id === groupId ? "secondary" : "ghost"}
                  className="justify-between"
                  onClick={() => {
                    setGroupId(group.id);
                    setSelectedChannelId(
                      channels.find((channel) => channel.groupId === group.id)
                        ?.id ?? "",
                    );
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        group.id === groupId
                          ? "bg-primary"
                          : "bg-muted-foreground/50",
                      )}
                    />
                    {group.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {
                      channels.filter((channel) => channel.groupId === group.id)
                        .length
                    }
                  </span>
                </Button>
              ))}
              <Separator className="my-3" />
              <div className="rounded-md border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
                M3U/TXT/JSON 直播源解析入口已保留。远程频道地址不会执行脚本。
              </div>
            </CardContent>
          </Card>

          <Card className="min-h-[640px]">
            <CardHeader className="border-b pb-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">频道列表</CardTitle>
                  <CardDescription>
                    {query.trim()
                      ? "搜索结果"
                      : (groups.find((group) => group.id === groupId)?.name ??
                        "全部")}{" "}
                    · {filteredChannels.length} 个频道
                  </CardDescription>
                </div>
                <div className="relative w-52">
                  <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索频道"
                    className="pl-9"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[565px]">
                <div className="flex flex-col gap-1 p-3">
                  {filteredChannels.map((channel) => {
                    const favorite = liveFavorites.includes(channel.id);
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-3 text-left transition-colors hover:bg-muted",
                          selectedChannel.id === channel.id &&
                            "bg-accent text-accent-foreground",
                        )}
                        onClick={() => selectChannel(channel)}
                      >
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-card text-sm font-semibold">
                          {channel.name.slice(0, 1)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {channel.name}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {channel.mediaKind.toUpperCase()} ·{" "}
                            {channel.groupName}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          {favorite && (
                            <Heart
                              className="fill-primary text-primary"
                              data-icon="inline-start"
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className={cn(
                              "size-2 rounded-full",
                              selectedChannel.id === channel.id
                                ? "bg-primary"
                                : "bg-[color:var(--status-supported)]",
                            )}
                          />
                        </span>
                      </button>
                    );
                  })}
                </div>
                <ScrollBar />
              </ScrollArea>
            </CardContent>
          </Card>

          <div className="flex min-w-0 flex-col gap-5">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">
                      {selectedChannel.name}
                    </CardTitle>
                    <CardDescription>
                      {selectedChannel.groupName} ·{" "}
                      {selectedChannel.mediaKind.toUpperCase()}
                    </CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant={
                      liveFavorites.includes(selectedChannel.id)
                        ? "secondary"
                        : "outline"
                    }
                    size="icon-sm"
                    aria-label={
                      liveFavorites.includes(selectedChannel.id)
                        ? "取消收藏频道"
                        : "收藏频道"
                    }
                    onClick={() => toggleLiveFavorite(selectedChannel)}
                  >
                    <Heart
                      className={cn(
                        liveFavorites.includes(selectedChannel.id) &&
                          "fill-primary text-primary",
                      )}
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <MediaPlayer
                  key={selectedChannel.streamUrl}
                  title={selectedChannel.name}
                  url={selectedChannel.streamUrl}
                  kind={selectedChannel.mediaKind}
                  onStatus={(nextStatus, message) => {
                    setStatus(nextStatus);
                    if (message) setDiagnostic(message);
                  }}
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        status === "error"
                          ? "bg-destructive"
                          : status === "playing"
                            ? "bg-[color:var(--status-supported)]"
                            : "bg-muted-foreground",
                      )}
                    />
                    {statusLabel(status)}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="上一台"
                      disabled={selectedIndex <= 0}
                      onClick={() => stepChannel(-1)}
                    >
                      <ChevronLeft
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="下一台"
                      disabled={
                        selectedIndex < 0 ||
                        selectedIndex >= channels.length - 1
                      }
                      onClick={() => stepChannel(1)}
                    >
                      <ChevronRight
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                    </Button>
                  </div>
                </div>
                {diagnostic && (
                  <Alert variant="destructive">
                    <CircleAlert data-icon="inline-start" aria-hidden="true" />
                    <AlertTitle>频道播放诊断</AlertTitle>
                    <AlertDescription>{diagnostic}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock3 data-icon="inline-start" aria-hidden="true" />
                  节目单 EPG
                </CardTitle>
                <CardDescription>
                  {selectedChannel.name} · 当前源节目单
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {programs.length > 0 ? (
                  programs.map((program, index) => (
                    <div
                      key={program.id}
                      className={cn(
                        "rounded-md border p-3",
                        index === 0 && "border-primary/50 bg-accent/50",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium">{program.title}</p>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {program.startAt}–{program.endAt}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {program.description}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="py-4 text-sm text-muted-foreground">
                    暂无 EPG 数据。
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
      <ScrollBar />
    </ScrollArea>
  );
}

function EmptyLiveState() {
  return (
    <div className="flex h-full items-center justify-center">
      <Empty className="max-w-md border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Radio data-icon="inline-start" aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>没有直播频道</EmptyTitle>
          <EmptyDescription>请先导入或启用直播源。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

function statusLabel(status: MediaStatus) {
  const labels: Record<MediaStatus, string> = {
    idle: "等待播放",
    loading: "正在连接",
    ready: "已准备",
    playing: "正在播放",
    paused: "已暂停",
    ended: "播放结束",
    error: "播放失败",
  };
  return labels[status];
}
