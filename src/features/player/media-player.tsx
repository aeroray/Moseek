import { useEffect, useRef, useState } from "react";
import Hls, {
  LoadStats,
  type HlsConfig,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from "hls.js";
import Plyr from "plyr";
import "plyr/dist/plyr.css";

import { fetchMediaResource, isTauriRuntime } from "@/lib/tauri";
import { getByteRangeHeader } from "@/features/player/media-range";
import type { MediaKind } from "@/types/moseek";

export type MediaStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "ended"
  | "error";

interface MediaPlayerProps {
  title: string;
  url: string;
  kind: MediaKind;
  isLive?: boolean;
  headers?: Record<string, string>;
  poster?: string;
  resumeAt?: number;
  onProgress?: (seconds: number) => void;
  onStatus?: (status: MediaStatus, message?: string) => void;
}

interface MediaSourceState {
  url: string;
  kind: MediaKind;
  isLive: boolean;
  headers?: Record<string, string>;
  poster?: string;
}

class TauriMediaLoader implements Loader<LoaderContext> {
  context: LoaderContext | null = null;
  stats = new LoadStats();
  private aborted = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private responseHeaders = new Map<string, string>();

  constructor(
    _config: HlsConfig,
    private readonly getRequestHeaders: () =>
      | Record<string, string>
      | undefined,
  ) {}

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ) {
    this.context = context;
    this.aborted = false;
    this.stats = new LoadStats();
    this.stats.loading.start = performance.now();
    const headers = { ...(this.getRequestHeaders() ?? {}), ...context.headers };
    const rangeHeader = getByteRangeHeader(
      context.rangeStart,
      context.rangeEnd,
    );
    if (rangeHeader) {
      headers.Range = rangeHeader;
    }
    let timedOut = false;
    const timeoutMs = Math.min(
      Math.max(
        config.loadPolicy.maxLoadTimeMs || config.timeout || 15_000,
        1_000,
      ),
      60_000,
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      this.timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error("媒体请求超时"));
      }, timeoutMs);
    });

    void Promise.race([
      fetchMediaResource(context.url, headers),
      timeoutPromise,
    ])
      .then((resource) => {
        if (this.aborted) return;
        if (!resource) throw new Error("桌面运行时未返回媒体资源");
        const bytes = decodeBase64(resource.bodyBase64);
        const now = performance.now();
        this.stats.loaded = bytes.byteLength;
        this.stats.total = bytes.byteLength;
        this.stats.loading.first = now;
        this.stats.loading.end = now;
        if (resource.contentType) {
          this.responseHeaders.set("content-type", resource.contentType);
        }
        let data: string | ArrayBuffer;
        if (context.responseType === "arraybuffer") {
          data = toArrayBuffer(bytes);
        } else {
          data = normalizeText(new TextDecoder().decode(bytes));
          if (isPlaylistContext(context) && !isHlsPlaylist(data)) {
            callbacks.onError(
              {
                code: 415,
                text: `媒体响应不是有效 HLS 清单（${resource.contentType ?? "未知类型"}）`,
              },
              context,
              null,
              this.stats,
            );
            return;
          }
        }
        callbacks.onSuccess(
          { url: resource.url || context.url, data, code: 200 },
          this.stats,
          context,
          null,
        );
      })
      .catch((error: unknown) => {
        if (this.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        if (timedOut) {
          callbacks.onTimeout(this.stats, context, null);
        } else {
          callbacks.onError(
            { code: 0, text: message },
            context,
            null,
            this.stats,
          );
        }
      })
      .finally(() => {
        if (this.timeoutId !== null) clearTimeout(this.timeoutId);
        this.timeoutId = null;
      });
  }

  abort() {
    this.aborted = true;
    this.stats.aborted = true;
    if (this.timeoutId !== null) clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }

  destroy() {
    this.abort();
    this.context = null;
    this.responseHeaders.clear();
  }

  getCacheAge() {
    return null;
  }

  getResponseHeader(name: string) {
    return this.responseHeaders.get(name.toLowerCase()) ?? null;
  }
}

function createTauriMediaLoader(sourceRef: { current: MediaSourceState }) {
  return class TauriMediaLoaderWithHeaders extends TauriMediaLoader {
    constructor(config: HlsConfig) {
      super(config, () => sourceRef.current.headers);
    }
  };
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function normalizeText(value: string) {
  return value.replace(/^\uFEFF/, "").trimStart();
}

function isPlaylistContext(context: LoaderContext) {
  return ["manifest", "level", "audioTrack", "subtitleTrack"].includes(
    context.type,
  );
}

function isHlsPlaylist(value: string) {
  return value.startsWith("#EXTM3U");
}

function isHlsSource(source: MediaSourceState) {
  return (
    source.isLive ||
    source.kind === "hls" ||
    source.url.toLowerCase().includes(".m3u8")
  );
}

export function MediaPlayer({
  url,
  kind,
  isLive = false,
  headers,
  poster,
  resumeAt = 0,
  onProgress,
  onStatus,
}: MediaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const callbackRef = useRef({ onProgress, onStatus });
  const resumeRef = useRef(resumeAt);
  const sourceRef = useRef<MediaSourceState>({
    url,
    kind,
    isLive,
    headers,
    poster,
  });
  const loadSourceRef = useRef<((source: MediaSourceState) => void) | null>(
    null,
  );
  const [isBuffering, setIsBuffering] = useState(isLive);

  useEffect(() => {
    callbackRef.current = { onProgress, onStatus };
    resumeRef.current = resumeAt;
  }, [onProgress, onStatus, resumeAt]);

  useEffect(() => {
    const source = { url, kind, isLive, headers, poster };
    sourceRef.current = source;
    loadSourceRef.current?.(source);
  }, [headers, isLive, kind, poster, url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const initialSource = sourceRef.current;
    const liveMode = initialSource.isLive;

    let lastProgress = -1;
    let disposed = false;
    let liveRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let startupWatchdog: ReturnType<typeof setTimeout> | null = null;
    let playbackRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let livePlayer: Plyr | null = null;
    let hasBufferedFragment = false;
    let playerReady = false;
    let playbackRequested = liveMode;
    let playbackAttemptInFlight = false;
    let playbackAttempts = 0;
    let sourceVersion = 0;
    const report = (status: MediaStatus, message?: string) => {
      if (liveMode && status === "error") setIsBuffering(false);
      callbackRef.current.onStatus?.(status, message);
    };
    const requestLivePlayback = async () => {
      if (
        !liveMode ||
        !livePlayer ||
        !hasBufferedFragment ||
        !playerReady ||
        !playbackRequested ||
        playbackAttemptInFlight ||
        disposed
      ) {
        return;
      }
      const attemptVersion = sourceVersion;
      playbackAttemptInFlight = true;
      const started = await startLivePlayback(livePlayer, video);
      playbackAttemptInFlight = false;
      if (disposed || attemptVersion !== sourceVersion) return;
      if (started) {
        playbackRequested = false;
        playbackAttempts = 0;
        setIsBuffering(false);
        return;
      }
      playbackRequested = true;
      playbackAttempts += 1;
      if (playbackAttempts >= 5) {
        report("error", "直播播放器未能启动，请点击播放按钮或切换频道重试。");
        return;
      }
      const delay = Math.min(250 * 2 ** (playbackAttempts - 1), 2_000);
      playbackRetryTimer = setTimeout(() => {
        playbackRetryTimer = null;
        requestLivePlayback();
      }, delay);
    };
    const startBufferedLivePlayback = () => {
      if (
        !liveMode ||
        !livePlayer ||
        !hasBufferedFragment ||
        !playerReady ||
        !playbackRequested ||
        disposed
      ) {
        return;
      }
      void requestLivePlayback();
    };
    const createPlayer = () => {
      const player = new Plyr(video, {
        autoplay: liveMode,
        seekTime: 10,
        settings: ["quality", "speed"],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        controls: liveMode
          ? [
              "play-large",
              "play",
              "mute",
              "volume",
              "settings",
              "pip",
              "fullscreen",
            ]
          : [
              "play-large",
              "restart",
              "play",
              "progress",
              "current-time",
              "duration",
              "mute",
              "volume",
              "settings",
              "pip",
              "fullscreen",
            ],
      });
      livePlayer = player;
      playerRef.current = player;
      if (liveMode) {
        // HLS live playback can buffer before Plyr emits its ready event.
        // The media element is the source of truth for starting playback.
        playerReady = true;
      }
      player.on("ready", () => {
        playerReady = true;
        const resume = resumeRef.current;
        if (
          resume > 5 &&
          Number.isFinite(player.duration) &&
          player.duration > resume
        ) {
          player.currentTime = resume;
        }
        if (!liveMode) report("ready");
        startBufferedLivePlayback();
      });
      player.on("play", () => {
        if (liveMode) {
          playbackRequested = true;
          setIsBuffering(true);
        }
      });
      player.on("playing", () => {
        playbackRequested = false;
        playbackAttempts = 0;
        setIsBuffering(false);
        report("playing");
      });
      player.on("waiting", () => {
        if (liveMode) setIsBuffering(true);
      });
      player.on("stalled", () => {
        if (liveMode) setIsBuffering(true);
      });
      player.on("pause", () => {
        if (!liveMode) report("paused");
      });
      player.on("ended", () => {
        if (!liveMode) report("ended");
      });
      player.on("error", () => report("error", "Plyr 无法播放当前媒体地址。"));
      player.on("timeupdate", () => {
        const currentTime = player.currentTime;
        if (Number.isFinite(currentTime) && currentTime - lastProgress >= 5) {
          lastProgress = currentTime;
          callbackRef.current.onProgress?.(currentTime);
        }
      });
      return player;
    };

    if (!liveMode) report("loading");
    video.poster = initialSource.poster ?? "";
    video.crossOrigin = "anonymous";
    video.autoplay = liveMode;
    video.defaultMuted = liveMode;
    video.muted = liveMode;
    video.preload = "auto";
    const isHls = isHlsSource(initialSource);
    if (isHls && Hls.isSupported()) {
      const hlsConfig: Partial<HlsConfig> = {
        enableWorker: true,
        lowLatencyMode: liveMode,
        startPosition: liveMode ? -1 : 0,
        liveDurationInfinity: liveMode,
        liveSyncMode: "edge",
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        maxBufferLength: liveMode ? 10 : 30,
        backBufferLength: liveMode ? 20 : Infinity,
        startFragPrefetch: liveMode,
      };
      if (isTauriRuntime()) {
        hlsConfig.loader = createTauriMediaLoader(sourceRef);
      } else {
        hlsConfig.xhrSetup = (xhr) => {
          Object.entries(sourceRef.current.headers ?? {}).forEach(
            ([name, value]) => {
              xhr.setRequestHeader(name, value);
            },
          );
        };
      }
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;
      let liveRecoveryAttempts = 0;
      const markMediaBuffered = () => {
        liveRecoveryAttempts = 0;
        hasBufferedFragment = true;
        if (startupWatchdog !== null) {
          clearTimeout(startupWatchdog);
          startupWatchdog = null;
        }
        startBufferedLivePlayback();
      };
      hls.on(Hls.Events.FRAG_BUFFERED, markMediaBuffered);
      hls.on(Hls.Events.BUFFER_APPENDED, markMediaBuffered);
      const armStartupWatchdog = () => {
        if (!liveMode || disposed || hasBufferedFragment) return;
        if (startupWatchdog !== null) clearTimeout(startupWatchdog);
        startupWatchdog = setTimeout(() => {
          startupWatchdog = null;
          if (!hasBufferedFragment && !recoverLiveWindow()) {
            report(
              "error",
              "直播流长时间没有收到可播放分片，请切换频道或稍后重试。",
            );
          }
        }, 10_000);
      };
      function recoverLiveWindow() {
        if (
          !liveMode ||
          liveRecoveryAttempts >= 2 ||
          disposed ||
          liveRecoveryTimer !== null
        ) {
          return false;
        }
        liveRecoveryAttempts += 1;
        playbackRequested = true;
        playbackAttempts = 0;
        hasBufferedFragment = false;
        hls.stopLoad();
        liveRecoveryTimer = setTimeout(() => {
          liveRecoveryTimer = null;
          if (disposed) return;
          hls.loadSource(sourceRef.current.url);
          hls.startLoad(-1);
          armStartupWatchdog();
        }, 600);
        return true;
      }
      armStartupWatchdog();
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          if (
            [
              "fragLoadError",
              "fragLoadTimeOut",
              "fragParsingError",
              "bufferAppendError",
            ].includes(data.details) &&
            recoverLiveWindow()
          ) {
            return;
          }
          report("error", formatHlsError(data.details, data.response?.code));
        }
      });
      createPlayer();
      hls.loadSource(initialSource.url);
      hls.attachMedia(video);
      loadSourceRef.current = (source) => {
        if (!isHlsSource(source)) return;
        if (liveRecoveryTimer !== null) {
          clearTimeout(liveRecoveryTimer);
          liveRecoveryTimer = null;
        }
        if (startupWatchdog !== null) clearTimeout(startupWatchdog);
        liveRecoveryAttempts = 0;
        sourceVersion += 1;
        playbackAttempts = 0;
        playbackAttemptInFlight = false;
        hasBufferedFragment = false;
        playbackRequested = source.isLive;
        setIsBuffering(source.isLive);
        video.poster = source.poster ?? "";
        hls.loadSource(source.url);
        hls.startLoad(-1);
      };
    } else if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
      report(
        "error",
        "当前运行环境不支持 HLS 播放，且无法使用 hls.js 接管该频道。",
      );
    } else {
      createPlayer();
      loadSourceRef.current = (source) => {
        if (isHlsSource(source)) return;
        setIsBuffering(false);
        video.poster = source.poster ?? "";
        video.src = source.url;
        video.load();
      };
      loadSourceRef.current(initialSource);
    }

    return () => {
      disposed = true;
      if (liveRecoveryTimer !== null) clearTimeout(liveRecoveryTimer);
      if (startupWatchdog !== null) clearTimeout(startupWatchdog);
      if (playbackRetryTimer !== null) clearTimeout(playbackRetryTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      playerRef.current?.destroy();
      playerRef.current = null;
      livePlayer = null;
      loadSourceRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [isLive]);

  return (
    <div
      className="relative overflow-hidden rounded-md bg-black shadow-2xl ring-1 ring-border/40"
      style={{ "--plyr-color-main": "var(--primary)" } as React.CSSProperties}
    >
      <video ref={videoRef} className="aspect-video w-full" playsInline />
      {isLive && isBuffering && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          aria-label="直播缓冲中"
        >
          <span className="size-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </div>
      )}
    </div>
  );
}

function formatHlsError(details?: string, statusCode?: number) {
  const status = statusCode ? `（HTTP ${statusCode}）` : "";
  switch (details) {
    case "manifestLoadError":
      if (statusCode === 415) {
        return "当前频道返回了 HTTP 200，但正文不是有效的 HLS 清单，已跳过该线路。";
      }
      return `当前频道的 HLS 清单请求失败${status}。频道目录可用，但上游播放地址可能已失效、拒绝访问或不允许跨域。`;
    case "manifestLoadTimeOut":
      return "当前频道的 HLS 清单请求超时。请稍后重试或切换其他频道。";
    case "fragLoadError":
      return `当前频道的 HLS 媒体分片请求失败${status}。清单已找到，但上游没有持续提供媒体数据。`;
    case "fragLoadTimeOut":
      return "当前频道的 HLS 媒体分片请求超时，直播窗口可能已经推进。";
    case "manifestParsingError":
      return `当前频道返回了无法解析的 HLS 清单${status}。上游可能返回了 HTML、JSON 错误页或其他非 M3U8 内容。`;
    case "fragParsingError":
      return "当前频道的 HLS 媒体分片已返回，但编码无法解析；可能是过期分片或上游编码不兼容。";
    case "bufferAppendError":
      return "当前频道的媒体分片无法加入播放缓冲区，正在等待新的直播窗口。";
    case "levelLoadError":
      return `当前频道的 HLS 码率清单请求失败${status}。上游播放地址可能已失效或拒绝访问。`;
    default:
      return `HLS 播放失败${status}：${details || "媒体流错误"}`;
  }
}

async function startLivePlayback(
  player: Plyr,
  video: HTMLVideoElement,
): Promise<boolean> {
  try {
    await video.play();
    return true;
  } catch {
    video.muted = true;
    player.muted = true;
    try {
      await video.play();
      return true;
    } catch {
      return false;
    }
  }
}
