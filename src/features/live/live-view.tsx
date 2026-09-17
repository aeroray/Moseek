import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Heart,
  ScrollText,
  Search,
  TriangleAlert,
  Tv,
  X,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import {
  findCurrentProgram,
  findNextProgram,
  loadEpg,
  loadLiveCatalog,
  resolveEpgRequest,
  resolveEpgUrl,
  type EpgAdapterResult,
} from "@/lib/live-adapter";
import {
  isTauriRuntime,
  probeStreamUrls,
  resolvePlayback,
  type PlaybackResolution,
  type StreamProbe,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import type { EpgProgram, LiveChannel, LiveCatalog } from "@/types/moseek";
import { MediaPlayer, usesHlsPipeline } from "@/features/player/media-player";
import { MediaDiagnosticPanel } from "@/features/player/media-diagnostic-panel";
import type { MediaDiagnosticSnapshot } from "@/features/player/media-diagnostics";

const maxAutomaticStreamAttempts = 3;
/** Sentinel for "browse every group", used by the group selector and by search. */
const ALL_GROUPS_ID = "__all_groups__";

export function LiveView() {
  const sources = useAppStore((state) => state.sources);
  const liveFavorites = useAppStore((state) => state.liveFavorites);
  const toggleLiveFavorite = useAppStore((state) => state.toggleLiveFavorite);
  const autoEpgEnabled = useAppStore((state) => state.autoEpgEnabled);
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
  const [epgMode, setEpgMode] = useState<EpgAdapterResult["mode"]>("empty");
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
  const [isDiagnosticOpen, setIsDiagnosticOpen] = useState(false);
  const [streamProbes, setStreamProbes] = useState<StreamProbe[] | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const streamIndexRef = useRef(0);
  /** Set once the user picks a line by hand, so auto-probing stops overriding their choice. */
  const pinnedStreamRef = useRef(false);

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
    setGroupId(ALL_GROUPS_ID);
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
    // Default to every group rather than the first one. A playlist's first group is an arbitrary
    // slice of it — often a small category the user did not ask for — so opening on it hid most
    // of the channels for no stated reason. Only fall back to a specific group when the current
    // selection no longer exists (the source changed under us).
    if (
      groupId !== ALL_GROUPS_ID &&
      groupId !== "" &&
      !groups.some((group) => group.id === groupId)
    ) {
      setGroupId(groups[0]?.id ?? ALL_GROUPS_ID);
    }
    if (!channels.some((channel) => channel.id === selectedChannelId)) {
      setSelectedChannelId(channels[0]?.id ?? "");
    }
  }, [channels, groupId, groups, selectedChannelId]);

  const filteredChannels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return channels.filter((channel) => {
      // A query searches across EVERY group; the group filter only applies when browsing.
      // The dropdown reflects this by showing "全部分组（搜索中）" so the visible scope and
      // the stated scope agree.
      const matchesGroup =
        Boolean(normalizedQuery) ||
        groupId === ALL_GROUPS_ID ||
        channel.groupId === groupId;
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
  // Providers identify the channel differently: an XMLTV guide keys on `tvg-id`, while a
  // per-channel JSON template (112114) only echoes back the name it was asked about. Match
  // on whichever identifiers the channel actually carries rather than assuming one.
  const epgKeys = selectedChannel
    ? [selectedChannel.epgId, selectedChannel.name, selectedChannel.id].filter(
        (key): key is string => Boolean(key),
      )
    : [];
  const programs = epgPrograms.filter((program) =>
    epgKeys.includes(program.channelId),
  );
  // Providers return the whole day from 00:00, so the first row is the earliest programme of
  // the day, not the one on air. Labelling it "当前" showed 01:08 at 11:52.
  const currentProgram = findCurrentProgram(programs);
  const nextProgram = findNextProgram(programs);
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
    pinnedStreamRef.current = false;
    setStreamIndex(0);
    setStreamProbes(null);
  }, [selectedChannel?.id]);

  // Probe every line at once and start on the one that actually answers fastest.
  //
  // The workspace used to try lines strictly in order: line 1 was handed to the player, the
  // player spent its own timeout failing, and only then was line 2 attempted. That is a long
  // serial wait and the working line is often not the first. Probing in parallel costs one
  // small request per line and picks a usable one immediately.
  //
  // The user's manual choice always wins: once they click a line number, `pinnedStreamRef`
  // suppresses the automatic override.
  const streamUrlsKey = streamUrls.join("|");
  useEffect(() => {
    let cancelled = false;
    if (pinnedStreamRef.current || !selectedChannel || streamUrls.length < 2) {
      setStreamProbes(null);
      setIsProbing(false);
      return () => {
        cancelled = true;
      };
    }
    setIsProbing(true);
    // `probeStreamUrls` returns null outside the desktop runtime, where the command is not
    // registered. Calling `.then` on that crashed the whole workspace — the channel list and the
    // player both disappeared, so a preview build could not play anything with more than one
    // line. Probing is an optimisation, so its absence must degrade to "no probe results".
    void Promise.resolve(probeStreamUrls(streamUrls))
      .then((probes) => {
        if (cancelled) return;
        setStreamProbes(probes);
        if (!probes) return;
        // Pick the quickest reachable line here rather than trusting the backend's ordering,
        // so the choice stays correct even if the list arrives unsorted.
        const fastest = probes
          .filter((probe) => probe.ok)
          .reduce<StreamProbe | null>(
            (best, probe) =>
              !best || probe.elapsedMs < best.elapsedMs ? probe : best,
            null,
          );
        if (!fastest) return;
        // Only move if the current line is not itself usable, so a working default is not
        // disturbed.
        const current = probes.find(
          (probe) => probe.index === streamIndexRef.current,
        );
        if (!current?.ok) {
          streamIndexRef.current = fastest.index;
          setStreamIndex(fastest.index);
          setResolvedStream(null);
        }
      })
      .catch(() => {
        // A failed probe is not a failure to play: the player still gets the selected line.
        if (!cancelled) setStreamProbes(null);
      })
      .finally(() => {
        if (!cancelled) setIsProbing(false);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the channel plus the resolved URL list: `streamUrls` is rebuilt on every render,
    // so depending on the array itself would re-probe in a loop.
  }, [selectedChannel?.id, streamUrlsKey]);

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

  /**
   * True once every line has been probed and none served a manifest. In that case the failure
   * is upstream — the addresses are unreachable from this machine — so the explanation is worth
   * stating. It used to be a banner over the player; it now leads the diagnosis instead, because
   * the player already reports that playback failed and the *reason* is what 播放诊断 is for.
   */
  const allLinesUnreachable = Boolean(
    streamProbes &&
      streamProbes.length > 0 &&
      streamProbes.every((probe) => !probe.ok),
  );

  const allLinesUnreachableNote = allLinesUnreachable
    ? `已并发测试 ${streamProbes?.length ?? 0} 条线路，全部未能取到直播清单。这类地址通常只对特定运营商网络开放（例如中国移动 IPTV 源需要移动宽带），换用其它频道或其它直播源即可正常观看。`
    : null;

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

  // A source may declare its own `epg`; otherwise the built-in guide is used so the user does
  // not have to hand-edit a TVBox template just to see what is on air.
  const epgRequest = useMemo(
    () => resolveEpgRequest(liveSource, autoEpgEnabled),
    [autoEpgEnabled, liveSource],
  );

  // Templates resolve per channel, but a fixed XMLTV guide resolves to the same string for
  // every channel. Keying the fetch on the resolved URL means the guide is fetched once for
  // a fixed URL and re-fetched per channel only when the template actually varies.
  const epgUrl = useMemo(
    () =>
      epgRequest && selectedChannel
        ? resolveEpgUrl(epgRequest.template, selectedChannel)
        : "",
    [epgRequest, selectedChannel],
  );

  useEffect(() => {
    let cancelled = false;
    setEpgMode("empty");
    if (!epgRequest || !selectedChannel || !epgUrl) {
      setEpgPrograms([]);
      setEpgError(null);
      return () => {
        cancelled = true;
      };
    }
    void loadEpg(epgRequest, selectedChannel).then((result) => {
      if (cancelled) return;
      setEpgPrograms(result.data.programs);
      setEpgError(result.error);
      setEpgMode(result.mode);
    });
    return () => {
      cancelled = true;
    };
  }, [epgRequest, epgUrl, selectedChannel]);

  const isSearching = query.trim().length > 0;
  // While searching, the group selector displays the cross-group scope rather than a group
  // that is no longer being applied.
  const groupFilterValue = isSearching ? ALL_GROUPS_ID : groupId;

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
      // Stepping while browsing "全部分组" (or searching) must not silently narrow the list to
      // the next channel's group.
      if (!isSearching && groupId !== ALL_GROUPS_ID) setGroupId(next.groupId);
      selectChannel(next);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* 48px Live Topbar. Three zones, matching the movie library: the scope controls (source +
          group) on the left, the search centred, and the channel controls on the right. */}
      <header
        className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none"
      >
        {/* Left: source + group. Both are scope controls — what is being browsed — so the group
            filter sits immediately beside the source it belongs to. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
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

          {/* Group filter. A playlist can carry dozens of `group-title` values, and rendering
              one chip per group pushed the row past the viewport and made the header read as
              noise. A dropdown keeps the bar a fixed height and scales to any number of groups,
              and it shows the active group's name even when the list is long.
              While a search is active the list spans every group, so the control says so
              instead of continuing to display the group that is no longer being applied. */}
          <Select
            value={groupFilterValue}
            onValueChange={(value) => {
              setQuery("");
              setGroupId(value);
              const firstInGroup = channels.find((c) => c.groupId === value);
              if (firstInGroup) selectChannel(firstInGroup);
            }}
            disabled={groups.length === 0}
          >
            <SelectTrigger
              size="sm"
              className={cn(
                "h-8 w-40 shrink-0 font-medium border-border/60 bg-muted/40 text-foreground",
                isSearching && "border-primary/40 text-primary",
              )}
              aria-label="频道分组"
            >
              <SelectValue placeholder="选择分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {/* Always offered, not only while searching: it is a genuinely useful browse
                    mode, and a value that exists only during a search would leave the select
                    holding a value with no matching item once the query cleared. */}
                <SelectItem value={ALL_GROUPS_ID}>
                  {isSearching ? "全部分组（搜索中）" : "全部分组"}
                </SelectItem>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {/* Centre: the search, widened to hold the width the group control gave up so the bar
            keeps its balance and the field stays the obvious focal point. The query deliberately
            spans every group (see `filteredChannels`), so the group dropdown beside it is
            bypassed while a search is active. The scope is named on the control itself rather
            than left implicit, because a group selector that still read "央视频道" while showing
            results from other groups is what made the search look group-scoped. */}
        <div className="relative w-80 shrink-0 lg:w-[29rem]">
          <Search
            className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
            data-icon="inline-start"
            aria-hidden="true"
          />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索全部频道名..."
            className="pl-8 pr-8 bg-muted/40 border-border/60"
            aria-label="搜索直播频道"
          />
          {isSearching && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="清除搜索"
              title="清除搜索，恢复分组筛选"
              className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="上一个频道"
            disabled={selectedIndex <= 0}
            onClick={() => stepChannel(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="下一个频道"
            disabled={
              selectedIndex < 0 || selectedIndex >= channels.length - 1
            }
            onClick={() => stepChannel(1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {/* Show the filtered count whenever the visible list is narrower than the whole
                catalog, so a search or group filter never looks like it changed nothing. */}
            {filteredChannels.length === channels.length
              ? `${channels.length} 个频道`
              : `${filteredChannels.length} / ${channels.length} 个频道`}
          </span>
          {selectedChannel && (
            <Button
              type="button"
              variant={isFavorite ? "secondary" : "outline"}
              size="sm"
              className="gap-1.5"
              onClick={() => toggleLiveFavorite(selectedChannel)}
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

      {/* Only a *catalog* failure is shown here: without channels there is nothing to watch, so
          the reason has to be visible. A guide failure is different — the channel still plays,
          and the strip below the player already says the guide is unavailable, so a banner on
          top of a working player would report a problem the user does not have. The raw error
          text (a reqwest chain naming DNS and deadlines) is not actionable either way; the
          specific reason belongs in 播放诊断, where it can be read in full. */}
      {loadError && (
        <div className="shrink-0 px-3 pt-2">
          <Alert variant="destructive" className="py-2">
            <TriangleAlert
              className="size-4"
              data-icon="inline-start"
              aria-hidden="true"
            />
            <AlertTitle className="text-xs font-semibold">
              直播源请求失败
            </AlertTitle>
            <AlertDescription className="text-xs text-destructive/90">
              无法读取这个直播源的频道列表，因此没有可播放的频道。
              请检查该源的地址是否有效，或在配置中心重新测试它。
            </AlertDescription>
          </Alert>
        </div>
      )}

      {/* Main Live Workspace: Dual-Pane (Left: Channel List, Right: Player + EPG) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Channel List (240px) */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-border/70 bg-card/20 overflow-hidden">
          {/* `min-h-0` is required: a flex item defaults to `min-height: auto`, so without
              it this root grows to the height of all 129 channel rows instead of the
              aside's box. The viewport then matches its own content, leaving nothing to
              scroll, and the aside's `overflow-hidden` silently clips the list.
              `type="auto"` keeps the scrollbar mounted while the list overflows, so the
              list advertises itself instead of only revealing a bar on hover. */}
          <ScrollArea type="auto" className="flex-1 min-h-0">
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
                  {isLoading ? "正在读取频道目录..." : "暂无匹配频道"}
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
                fill
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

            {/* No in-player alert here. The player already shows "无法播放当前内容" with a retry
                action, and a second banner saying the same thing on top of it only competed for
                attention. The specific cause is available in 播放诊断, which is where a user who
                wants it will look. */}
          </div>

          {/* Bottom Live Control & EPG Strip (44px) */}
          <div className="flex h-11 shrink-0 items-center justify-between border-t border-border/70 bg-card/60 px-4 select-none">
            <div className="flex items-center gap-3 text-xs min-w-0">
              <span className="font-semibold text-foreground truncate">
                {selectedChannel?.name || "未选中频道"}
              </span>
              <span className="text-muted-foreground">|</span>
              <div className="flex items-center gap-1.5 overflow-hidden text-muted-foreground text-xs">
                {currentProgram ? (
                  <>
                    <span className="text-primary font-medium truncate">
                      当前：{currentProgram.title}
                    </span>
                    {nextProgram && (
                      <span className="truncate hidden md:inline">
                        → 稍后：{nextProgram.title}
                      </span>
                    )}
                  </>
                ) : programs.length > 0 ? (
                  // The guide loaded and matched this channel, but no row covers the current
                  // minute; saying "no data" here would contradict the rows we do hold.
                  <span>今日节目已播完</span>
                ) : (
                  <span>
                    {epgMode === "unrecognized"
                      ? "节目单源未收录该频道"
                      : epgError
                        ? "节目单获取失败"
                        : !liveSource?.epg && !autoEpgEnabled
                          ? "已关闭自动节目单，且该源未配置 EPG 地址"
                          : "该频道暂无节目单数据"}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {streamUrls.length > 1 && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span>{isProbing ? "测速中：" : "线路："}</span>
                  {streamUrls.map((_, idx) => {
                    const probe = streamProbes?.find((item) => item.index === idx);
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          // A deliberate choice outranks the automatic probe result.
                          pinnedStreamRef.current = true;
                          streamIndexRef.current = idx;
                          setStreamIndex(idx);
                          setResolvedStream(null);
                        }}
                        title={
                          probe
                            ? probe.ok
                              ? `可用 · ${probe.elapsedMs} 毫秒`
                              : probe.message
                            : undefined
                        }
                        aria-label={
                          probe
                            ? `线路 ${idx + 1}${probe.ok ? "（可用）" : "（不可用）"}`
                            : `线路 ${idx + 1}`
                        }
                        className={cn(
                          "size-6 rounded text-xs font-bold transition-colors",
                          streamIndex === idx
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted/80 hover:bg-muted text-foreground",
                          // A probed-dead line is dimmed so the working ones stand out, but it
                          // stays clickable: the probe can be wrong about an operator-restricted
                          // address, and the user may know better.
                          probe && !probe.ok && streamIndex !== idx && "opacity-40",
                        )}
                      >
                        {idx + 1}
                      </button>
                    );
                  })}
                </div>
              )}

              <Dialog open={isDiagnosticOpen} onOpenChange={setIsDiagnosticOpen}>
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                  >
                    <ScrollText
                      className="size-3.5"
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    播放诊断
                  </Button>
                </DialogTrigger>
                <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
                  {/* The panel carries the visible heading and the copy action, so the dialog's
                      own title exists only to name the dialog for assistive technology. This is
                      the same dialog the movie library opens — one presentation of one thing,
                      rather than a drawer here and a dialog there. */}
                  <DialogHeader className="sr-only">
                    <DialogTitle>播放诊断</DialogTitle>
                    <DialogDescription>
                      播放失败时复制这段内容，可直接定位到具体环节
                    </DialogDescription>
                  </DialogHeader>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <MediaDiagnosticPanel
                      className="border-0 bg-transparent backdrop-blur-none"
                      snapshot={mediaDiagnostic}
                      note={allLinesUnreachableNote ?? diagnostic}
                    />
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
