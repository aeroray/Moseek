import { useEffect, useRef } from "react";
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
  headers?: Record<string, string>;
  poster?: string;
  resumeAt?: number;
  onProgress?: (seconds: number) => void;
  onStatus?: (status: MediaStatus, message?: string) => void;
}

class TauriMediaLoader implements Loader<LoaderContext> {
  context: LoaderContext | null = null;
  stats = new LoadStats();
  private aborted = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private responseHeaders = new Map<string, string>();

  constructor(
    _config: HlsConfig,
    private readonly requestHeaders: Record<string, string> = {},
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
    const headers = { ...this.requestHeaders, ...context.headers };
    if (context.rangeStart !== undefined) {
      headers.Range = `bytes=${context.rangeStart}-${context.rangeEnd ?? ""}`;
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
        const data =
          context.responseType === "arraybuffer"
            ? toArrayBuffer(bytes)
            : new TextDecoder().decode(bytes);
        callbacks.onSuccess(
          { url: context.url, data, code: 200 },
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

function createTauriMediaLoader(headers?: Record<string, string>) {
  return class TauriMediaLoaderWithHeaders extends TauriMediaLoader {
    constructor(config: HlsConfig) {
      super(config, headers);
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

export function MediaPlayer({
  title,
  url,
  kind,
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

  useEffect(() => {
    callbackRef.current = { onProgress, onStatus };
    resumeRef.current = resumeAt;
  }, [onProgress, onStatus, resumeAt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let lastProgress = -1;
    const report = (status: MediaStatus, message?: string) => {
      callbackRef.current.onStatus?.(status, message);
    };
    const createPlayer = () => {
      const player = new Plyr(video, {
        autoplay: false,
        seekTime: 10,
        settings: ["quality", "speed"],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        controls: [
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
      playerRef.current = player;
      player.on("ready", () => {
        const resume = resumeRef.current;
        if (
          resume > 5 &&
          Number.isFinite(player.duration) &&
          player.duration > resume
        ) {
          player.currentTime = resume;
        }
        report("ready");
      });
      player.on("playing", () => report("playing"));
      player.on("pause", () => report("paused"));
      player.on("ended", () => report("ended"));
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

    report("loading");
    video.poster = poster ?? "";
    video.crossOrigin = "anonymous";
    const isHls = kind === "hls" || url.toLowerCase().includes(".m3u8");
    if (isHls && Hls.isSupported()) {
      const hlsConfig: Partial<HlsConfig> = {
        enableWorker: true,
        lowLatencyMode: false,
      };
      if (isTauriRuntime()) {
        hlsConfig.loader = createTauriMediaLoader(headers);
      } else {
        hlsConfig.xhrSetup = (xhr) => {
          Object.entries(headers ?? {}).forEach(([name, value]) => {
            xhr.setRequestHeader(name, value);
          });
        };
      }
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          report("error", formatHlsError(data.details, data.response?.code));
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        createPlayer();
      });
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(url);
      });
      hls.attachMedia(video);
    } else if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
      report(
        "error",
        "当前运行环境不支持 HLS 播放，且无法使用 hls.js 接管该频道。",
      );
    } else {
      video.src = url;
      createPlayer();
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      playerRef.current?.destroy();
      playerRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [headers, kind, poster, title, url]);

  return (
    <div
      className="overflow-hidden rounded-md bg-black shadow-2xl ring-1 ring-border/40"
      style={{ "--plyr-color-main": "var(--primary)" } as React.CSSProperties}
    >
      <video ref={videoRef} className="aspect-video w-full" playsInline />
    </div>
  );
}

function formatHlsError(details?: string, statusCode?: number) {
  const status = statusCode ? `（HTTP ${statusCode}）` : "";
  switch (details) {
    case "manifestLoadError":
      return `当前频道的 HLS 清单请求失败${status}。频道目录可用，但上游播放地址可能已失效、拒绝访问或不允许跨域。`;
    case "manifestLoadTimeOut":
      return "当前频道的 HLS 清单请求超时。请稍后重试或切换其他频道。";
    case "fragLoadError":
      return `当前频道的 HLS 媒体分片请求失败${status}。清单已找到，但上游没有持续提供媒体数据。`;
    case "levelLoadError":
      return `当前频道的 HLS 码率清单请求失败${status}。上游播放地址可能已失效或拒绝访问。`;
    default:
      return `HLS 播放失败${status}：${details || "媒体流错误"}`;
  }
}
