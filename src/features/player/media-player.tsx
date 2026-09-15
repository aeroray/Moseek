import { useEffect, useRef, useState } from "react";
import Hls, {
  LoadStats,
  type ErrorData,
  type HlsConfig,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from "hls.js";
import { CircleAlert, RotateCw } from "lucide-react";
import Plyr from "plyr";
import "plyr/dist/plyr.css";

import { Button } from "@/components/ui/button";
import { fetchMediaResource, isTauriRuntime } from "@/lib/tauri";
import { getByteRangeHeader } from "@/features/player/media-range";
import {
  createDiagnosticRecorder,
  describeHlsError,
  describeMediaElement,
  describePipeline,
  extractUpstreamStatus,
  formatHlsError,
  mediaStatusLabels,
  probeMediaEnvironment,
  type MediaDiagnosticSnapshot,
  type MediaEnvironmentReport,
  type MediaPipelineSnapshot,
  type MediaStatus,
} from "@/features/player/media-diagnostics";
import type { MediaKind } from "@/types/moseek";

export type { MediaStatus };

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
  onDiagnostic?: (snapshot: MediaDiagnosticSnapshot) => void;
}

let cachedTransmuxWorkerSupport: boolean | null = null;

/**
 * Playlists are a few kilobytes, so a manifest request gets a much smaller budget than a
 * media fragment. Without it a non-HLS address (an MP4 behind a `.php` endpoint, for
 * example) streams megabytes into memory before failing with a size limit instead of
 * "this is not a playlist".
 */
const PLAYLIST_MAX_BYTES = 1024 * 1024;

/**
 * Decides whether a source must be played through hls.js.
 *
 * A live channel is normally HLS even without the extension, but an explicit mp4 is never an
 * HLS manifest: forcing one through hls.js downloaded the whole file and then failed with a
 * size-limit error instead of playing it. Exported so callers can key the player on the
 * pipeline, because switching between the two kinds needs a fresh player.
 */
export function usesHlsPipeline(kind: MediaKind, isLive: boolean, url: string) {
  if (kind === "mp4") return false;
  return isLive || kind === "hls" || url.toLowerCase().includes(".m3u8");
}

function shouldStartWithTransmuxWorker() {
  return cachedTransmuxWorkerSupport !== false;
}

function truncateForDiagnostics(value: string | undefined, limit = 96) {
  if (!value) return "未知";
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
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
      fetchMediaResource(
        context.url,
        headers,
        isPlaylistContext(context) ? PLAYLIST_MAX_BYTES : undefined,
      ),
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
            { code: extractUpstreamStatus(message), text: message },
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
  return usesHlsPipeline(source.kind, source.isLive, source.url);
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
  onDiagnostic,
}: MediaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const callbackRef = useRef({ onProgress, onStatus, onDiagnostic });
  const resumeRef = useRef(resumeAt);
  const recorderRef = useRef(createDiagnosticRecorder());
  const environmentRef = useRef<MediaEnvironmentReport | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
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
  const [hasFailed, setHasFailed] = useState(false);

  useEffect(() => {
    callbackRef.current = { onProgress, onStatus, onDiagnostic };
    resumeRef.current = resumeAt;
  }, [onDiagnostic, onProgress, onStatus, resumeAt]);

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
    const recorder = recorderRef.current;

    let lastProgress = -1;
    let disposed = false;
    let liveRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let startupWatchdog: ReturnType<typeof setTimeout> | null = null;
    let playbackRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let diagnosticTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDiagnosticFlush = 0;
    let livePlayer: Plyr | null = null;
    let hasBufferedFragment = false;
    let playerReady = false;
    let playbackRequested = liveMode;
    let playbackAttemptInFlight = false;
    let playbackAttempts = 0;
    let sourceVersion = 0;
    let pipelineMode: MediaPipelineSnapshot["mode"] = "native";
    let attachedMediaSource: MediaSource | null = null;
    let status: MediaStatus = "idle";
    let lastMessage: string | null = null;

    const buildSnapshot = (): MediaDiagnosticSnapshot => ({
      status,
      message: lastMessage,
      source: {
        url: sourceRef.current.url,
        kind: sourceRef.current.kind,
        isLive: sourceRef.current.isLive,
        headers: sourceRef.current.headers ?? {},
      },
      environment: environmentRef.current,
      media: describeMediaElement(video),
      pipeline: describePipeline(
        hlsRef.current,
        pipelineMode,
        video,
        attachedMediaSource,
      ),
      events: recorder.list(),
    });
    const flushDiagnostics = () => {
      diagnosticTimer = null;
      lastDiagnosticFlush = Date.now();
      callbackRef.current.onDiagnostic?.(buildSnapshot());
    };
    const scheduleDiagnosticFlush = (immediate = false) => {
      if (!callbackRef.current.onDiagnostic) return;
      if (immediate) {
        if (diagnosticTimer !== null) {
          clearTimeout(diagnosticTimer);
          diagnosticTimer = null;
        }
        flushDiagnostics();
        return;
      }
      if (diagnosticTimer !== null) return;
      const wait = Math.max(0, 300 - (Date.now() - lastDiagnosticFlush));
      diagnosticTimer = setTimeout(flushDiagnostics, wait);
    };
    const report = (nextStatus: MediaStatus, message?: string) => {
      status = nextStatus;
      lastMessage = message ?? null;
      if (liveMode && nextStatus === "error") setIsBuffering(false);
      if (nextStatus === "error") setHasFailed(true);
      if (nextStatus === "playing") setHasFailed(false);
      recorder.push(`播放状态：${mediaStatusLabels[nextStatus]}`, message);
      callbackRef.current.onStatus?.(nextStatus, message);
      scheduleDiagnosticFlush(nextStatus === "error");
    };

    // Plyr wraps the <video> element in its own DOM and hls.js attaches a MediaSource
    // to it. Neither can be constructed twice on the same element, but React StrictMode
    // mounts, unmounts and remounts effects in development, which would build both
    // libraries twice and leave the player DOM torn down: a black player surface with
    // no media events and playback that never starts. Deferring the construction by one
    // macrotask lets the StrictMode unmount cancel it, so it happens exactly once.
    let bootTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleBoot = (task: () => void) => {
      if (bootTimer !== null) clearTimeout(bootTimer);
      bootTimer = setTimeout(() => {
        bootTimer = null;
        if (disposed) return;
        recorder.push(
          "开始装载媒体",
          `${initialSource.kind} · ${initialSource.url}`,
        );
        void probeMediaEnvironment().then((environment) => {
          if (disposed) return;
          environmentRef.current = environment;
          cachedTransmuxWorkerSupport = environment.transmuxWorkerSupported;
          recorder.push(
            "运行环境探测",
            `MediaSource=${environment.mediaSourceSupported} hls.js=${environment.hlsJsSupported} 转封装线程=${environment.transmuxWorkerSupported}`,
          );
          if (!environment.transmuxWorkerSupported) {
            recorder.push("环境提示", environment.transmuxWorkerNote);
          }
          scheduleDiagnosticFlush(true);
        });
        task();
      }, 0);
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
        recorder.push(
          "播放请求已接受",
          `readyState=${video.readyState} buffered=${describeMediaElement(video).buffered}`,
        );
        scheduleDiagnosticFlush(true);
        return;
      }
      playbackRequested = true;
      playbackAttempts += 1;
      recorder.push(
        "播放请求被拒绝",
        `第 ${playbackAttempts} 次 · readyState=${video.readyState} networkState=${video.networkState}`,
      );
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
        recorder.push("媒体元素开始播放请求");
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
        recorder.push("缓冲等待");
        scheduleDiagnosticFlush();
        if (liveMode) setIsBuffering(true);
      });
      player.on("stalled", () => {
        recorder.push("数据停滞", `networkState=${video.networkState}`);
        scheduleDiagnosticFlush();
        if (liveMode) setIsBuffering(true);
      });
      player.on("pause", () => {
        if (!liveMode) report("paused");
      });
      player.on("ended", () => {
        if (!liveMode) report("ended");
      });
      player.on("error", () => {
        const mediaError = video.error;
        report(
          "error",
          mediaError
            ? `媒体元素解码失败（code ${mediaError.code}：${mediaError.message || "无详细信息"}）。`
            : "Plyr 无法播放当前媒体地址。",
        );
      });
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
    // `crossOrigin` is deliberately left unset. Setting it makes the element demand CORS
    // headers from the media host, which can only break the native path (a live mp4 or a VOD
    // file) and buys nothing: nothing here reads pixels back through canvas, captureStream,
    // or WebAudio, and the HLS path feeds the element from a same-origin MediaSource blob.
    video.autoplay = liveMode;
    video.defaultMuted = liveMode;
    video.muted = liveMode;
    video.preload = "auto";
    const isHls = isHlsSource(initialSource);
    if (isHls && Hls.isSupported()) {
      let hls: Hls | null = null;
      let liveRecoveryAttempts = 0;
      let workerFallbackUsed = false;
      let playerCreated = false;

      const markMediaBuffered = () => {
        liveRecoveryAttempts = 0;
        hasBufferedFragment = true;
        if (startupWatchdog !== null) {
          clearTimeout(startupWatchdog);
          startupWatchdog = null;
        }
        startBufferedLivePlayback();
      };
      const armStartupWatchdog = () => {
        if (!liveMode || disposed || hasBufferedFragment) return;
        if (startupWatchdog !== null) clearTimeout(startupWatchdog);
        startupWatchdog = setTimeout(() => {
          startupWatchdog = null;
          if (!hasBufferedFragment) {
            recorder.push(
              "启动看门狗触发",
              "10 秒内没有收到可播放分片",
            );
            if (!recoverLiveWindow()) {
              report(
                "error",
                "直播流长时间没有收到可播放分片，请切换频道或稍后重试。",
              );
            }
          }
        }, 10_000);
      };
      function recoverLiveWindow() {
        const instance = hls;
        if (
          !liveMode ||
          liveRecoveryAttempts >= 2 ||
          disposed ||
          liveRecoveryTimer !== null ||
          !instance
        ) {
          return false;
        }
        liveRecoveryAttempts += 1;
        playbackRequested = true;
        playbackAttempts = 0;
        hasBufferedFragment = false;
        instance.stopLoad();
        recorder.push("尝试刷新直播窗口", `第 ${liveRecoveryAttempts} 次`);
        scheduleDiagnosticFlush(true);
        liveRecoveryTimer = setTimeout(() => {
          liveRecoveryTimer = null;
          if (disposed) return;
          instance.loadSource(sourceRef.current.url);
          instance.startLoad(-1);
          armStartupWatchdog();
        }, 600);
        return true;
      }
      const handleHlsError = (_event: unknown, data: ErrorData) => {
        recorder.push(
          data.fatal ? "HLS 致命错误" : "HLS 非致命错误",
          describeHlsError(data),
        );
        if (!data.fatal) {
          // hls.js only clears its own `enableWorker` flag when the injected
          // transmuxer worker fails asynchronously (a CSP without `worker-src blob:`
          // does exactly that). It never re-queues the pending fragment, so the
          // pipeline goes quiet until the startup watchdog gives up.
          if (
            data.details === "internalException" &&
            data.event === "demuxerWorker"
          ) {
            if (!workerFallbackUsed && !disposed) {
              workerFallbackUsed = true;
              recorder.push(
                "转封装线程不可用",
                "改用主线程转封装并重新装载当前地址",
              );
              restartPipeline(false);
              return;
            }
            report("error", "当前运行环境无法启动 HLS 转封装线程，直播流无法解码。");
          }
          scheduleDiagnosticFlush();
          return;
        }
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
        report(
          "error",
          formatHlsError(data.details, data.response?.code, data.response?.text),
        );
      };
      const createHlsInstanceNow = (enableWorker: boolean) => {
        const hlsConfig: Partial<HlsConfig> = {
          enableWorker,
          lowLatencyMode: liveMode,
          startPosition: liveMode ? -1 : 0,
          liveDurationInfinity: liveMode,
          liveSyncMode: "edge",
          // Public IPTV sources routinely deliver a fragment slower than real time, so the
          // player needs a cushion to ride out the slow patches. The cushion is bounded by the
          // start position (you can only buffer from where playback begins up to the live
          // edge), so starting one fragment further back is what actually buys resilience;
          // the buffer cap is kept above it and the latency cap above that, so neither ever
          // forces a mid-playback catch-up seek.
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          maxBufferLength: 30,
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
        const instance = new Hls(hlsConfig);
        hls = instance;
        hlsRef.current = instance;
        pipelineMode = enableWorker ? "hls-worker" : "hls-inline";
        recorder.push(
          "创建 hls.js 实例",
          `enableWorker=${enableWorker}`,
        );
        instance.on(Hls.Events.MANIFEST_LOADING, () => {
          recorder.push("请求媒体清单", truncateForDiagnostics(sourceRef.current.url));
        });
        instance.on(Hls.Events.MANIFEST_LOADED, (_event, data) => {
          recorder.push(
            "清单已返回",
            `码率档位 ${data.levels?.length ?? 0} · 音频轨 ${data.audioTracks?.length ?? 0}`,
          );
        });
        instance.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          recorder.push(
            "清单已解析",
            `码率档位 ${data.levels?.length ?? 0}`,
          );
        });
        instance.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          recorder.push(
            "码率清单已加载",
            `起始序号 ${data.details?.startSN ?? "未知"} · 分片 ${data.details?.fragments?.length ?? 0} · live=${Boolean(data.details?.live)}`,
          );
        });
        instance.on(Hls.Events.FRAG_LOADING, (_event, data) => {
          recorder.push("请求分片", `序号 ${data.frag?.sn ?? "未知"}`);
        });
        instance.on(Hls.Events.FRAG_LOADED, (_event, data) => {
          recorder.push(
            "分片已返回",
            `序号 ${data.frag?.sn ?? "未知"} · ${data.payload?.byteLength ?? 0} 字节`,
          );
        });
        instance.on(Hls.Events.MEDIA_ATTACHED, (_event, data) => {
          attachedMediaSource = data.mediaSource ?? null;
          recorder.push(
            "媒体元素已挂载 MediaSource",
            `readyState=${attachedMediaSource?.readyState ?? "未创建"}`,
          );
        });
        instance.on(Hls.Events.FRAG_BUFFERED, markMediaBuffered);
        instance.on(Hls.Events.BUFFER_APPENDED, markMediaBuffered);
        instance.on(Hls.Events.ERROR, handleHlsError);
        if (!playerCreated) {
          createPlayer();
          playerCreated = true;
        }
        instance.loadSource(sourceRef.current.url);
        instance.attachMedia(video);
        return instance;
      };
      const restartPipeline = (enableWorker: boolean) => {
        const previous = hls;
        if (liveRecoveryTimer !== null) {
          clearTimeout(liveRecoveryTimer);
          liveRecoveryTimer = null;
        }
        if (startupWatchdog !== null) {
          clearTimeout(startupWatchdog);
          startupWatchdog = null;
        }
        hasBufferedFragment = false;
        liveRecoveryAttempts = 0;
        playbackAttempts = 0;
        playbackAttemptInFlight = false;
        playbackRequested = liveMode;
        sourceVersion += 1;
        attachedMediaSource = null;
        setIsBuffering(liveMode);
        previous?.destroy();
        if (disposed) return;
        createHlsInstanceNow(enableWorker);
        armStartupWatchdog();
      };
      const retryCurrentSource = () => {
        setHasFailed(false);
        status = "loading";
        lastMessage = null;
        recorder.push("用户重试", "重新装载当前地址");
        restartPipeline(workerFallbackUsed ? false : shouldStartWithTransmuxWorker());
      };

      const startWithTransmuxWorker = shouldStartWithTransmuxWorker();
      pipelineMode = startWithTransmuxWorker ? "hls-worker" : "hls-inline";
      armStartupWatchdog();
      scheduleBoot(() => createHlsInstanceNow(startWithTransmuxWorker));
      retryRef.current = retryCurrentSource;
      loadSourceRef.current = (source) => {
        const instance = hls;
        if (!instance || !isHlsSource(source)) return;
        if (liveRecoveryTimer !== null) {
          clearTimeout(liveRecoveryTimer);
          liveRecoveryTimer = null;
        }
        if (startupWatchdog !== null) {
          clearTimeout(startupWatchdog);
          startupWatchdog = null;
        }
        liveRecoveryAttempts = 0;
        sourceVersion += 1;
        playbackAttempts = 0;
        playbackAttemptInFlight = false;
        hasBufferedFragment = false;
        playbackRequested = source.isLive;
        setIsBuffering(source.isLive);
        setHasFailed(false);
        video.poster = source.poster ?? "";
        recorder.push("切换播放地址", truncateForDiagnostics(source.url));
        instance.loadSource(source.url);
        instance.startLoad(-1);
        scheduleDiagnosticFlush(true);
      };
    } else if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
      report(
        "error",
        "当前运行环境不支持 HLS 播放，且无法使用 hls.js 接管该频道。",
      );
    } else {
      pipelineMode = "native";
      loadSourceRef.current = (source) => {
        if (isHlsSource(source)) return;
        setIsBuffering(false);
        setHasFailed(false);
        video.poster = source.poster ?? "";
        recorder.push("原生装载地址", truncateForDiagnostics(source.url));
        video.src = source.url;
        video.load();
      };
      retryRef.current = () => {
        setHasFailed(false);
        recorder.push("用户重试", "重新装载当前地址");
        video.poster = sourceRef.current.poster ?? "";
        video.src = sourceRef.current.url;
        video.load();
      };
      scheduleBoot(() => {
        createPlayer();
        loadSourceRef.current?.(initialSource);
      });
    }

    scheduleDiagnosticFlush(true);

    return () => {
      disposed = true;
      if (bootTimer !== null) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      if (liveRecoveryTimer !== null) clearTimeout(liveRecoveryTimer);
      if (startupWatchdog !== null) clearTimeout(startupWatchdog);
      if (playbackRetryTimer !== null) clearTimeout(playbackRetryTimer);
      if (diagnosticTimer !== null) clearTimeout(diagnosticTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      playerRef.current?.destroy();
      playerRef.current = null;
      livePlayer = null;
      loadSourceRef.current = null;
      retryRef.current = null;
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
      {isLive && isBuffering && !hasFailed && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          aria-label="直播缓冲中"
        >
          <span className="size-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </div>
      )}
      {hasFailed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 px-8 text-center">
          <CircleAlert
            className="size-7 text-white/70"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-white">无法播放当前内容</p>
          <p className="max-w-md text-xs leading-5 text-white/70">
            {isLive
              ? "已尝试可用的线路，但仍未能取得可播放的画面。"
              : "播放器未能取得可播放的画面。"}
            常见原因是上游地址已失效、本机网络无法访问该地址，或当前播放环境不支持该媒体格式。
            具体环节见下方「播放诊断」。
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => retryRef.current?.()}
          >
            <RotateCw data-icon="inline-start" aria-hidden="true" />
            重试
          </Button>
        </div>
      )}
    </div>
  );
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
