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
import Mpegts from "mpegts.js";
import { CircleAlert, RotateCw } from "lucide-react";
import Plyr from "plyr";
import "plyr/dist/plyr.css";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fetchMediaResource,
  isTauriRuntime,
  probeMediaContainer,
  streamMediaResource,
  type MediaStreamMeta,
} from "@/lib/tauri";
import { getByteRangeHeader, isEmptyFragmentResponse } from "@/features/player/media-range";
import { useViewActive } from "@/components/view-pane";
import {
  clearsFailureNote,
  decideLiveWatchdog,
} from "@/features/player/live-watchdog";
import {
  resolveMediaPipeline,
  shouldProbeContainer,
  type MediaContainerEvidence,
} from "@/features/player/media-pipeline";
import {
  createDiagnosticRecorder,
  describeHlsError,
  describeMediaElement,
  describeMpegtsError,
  describePipeline,
  extractUpstreamStatus,
  formatHlsError,
  formatMpegtsError,
  mediaStatusLabels,
  probeMediaEnvironment,
  type MediaDiagnosticSnapshot,
  type MediaEnvironmentReport,
  type MediaPipelineSnapshot,
  type MediaStatus,
} from "@/features/player/media-diagnostics";
import type { MediaKind } from "@/types/moseek";

export type { MediaStatus };
export { resolveMediaPipeline, usesHlsPipeline } from "@/features/player/media-pipeline";

interface MediaPlayerProps {
  title: string;
  url: string;
  kind: MediaKind;
  isLive?: boolean;
  /**
   * Stretch the player to fill its container instead of sizing to the video's own
   * aspect-ratio box. Used by the live workspace, where the player is centred inside a
   * large pane and an intrinsically sized wrapper would collapse to 300x150.
   */
  fill?: boolean;
  headers?: Record<string, string>;
  poster?: string;
  resumeAt?: number;
  onProgress?: (seconds: number) => void;
  onStatus?: (status: MediaStatus, message?: string) => void;
  onDiagnostic?: (snapshot: MediaDiagnosticSnapshot) => void;
  /**
   * Fired once the media element can actually start playing (`canplay`/`loadeddata`).
   *
   * Plyr's own `ready` event is not this signal: it fires when Plyr finishes building its DOM,
   * which happens before a single byte of media has been fetched. A page that reveals its
   * player on `ready` shows a working-looking surface for a URL that then fails seconds later.
   * Callers that want to gate the surface on real playability listen here instead.
   */
  onPlayable?: () => void;
}

let cachedTransmuxWorkerSupport: boolean | null = null;

/**
 * What the player reports to whichever pipeline is currently attached.
 *
 * The player instance is created once for the element's lifetime and never rebuilt; the library
 * behind it (hls.js, mpegts.js, or the element's own native playback) is what gets swapped when the
 * pipeline changes. So the player's listeners cannot close over one pipeline's state — they reach
 * the current pipeline's handlers through this, which each pipeline effect installs on the way in
 * and clears on the way out.
 *
 * **Rebuilding the player instead is not an option, and that is what broke live FLV playback.**
 * Plyr refuses to initialise an element twice — `setup()` returns early on `if (this.media.plyr)`
 * with "Target already setup", and nothing in Plyr ever clears that back-reference, including
 * `destroy()`. Measured on the real channel this was reported from: after the container probe turned
 * the URL-derived HLS guess into an FLV pipeline, `new Plyr(video)` produced **no container, no
 * `ready`, and no error**, so the app never received a `playing` event — while mpegts.js was decoding
 * 425 frames into that element. Plyr's `destroy()` also replaces the element with a *clone*, leaving
 * the one being driven outside the document. The user saw both halves at once: nothing played, and no
 * player appeared.
 */
interface MediaPipelineEvents {
  onReady: () => void;
  onPlay: () => void;
  onPlaying: () => void;
  onWaiting: () => void;
  onStalled: () => void;
  onPause: () => void;
  onEnded: () => void;
  onError: () => void;
  onTimeUpdate: (currentTime: number) => void;
}

/**
 * Playlists are a few kilobytes, so a manifest request gets a much smaller budget than a
 * media fragment. Without it a non-HLS address (an MP4 behind a `.php` endpoint, for
 * example) streams megabytes into memory before failing with a size limit instead of
 * "this is not a playlist".
 */
const PLAYLIST_MAX_BYTES = 1024 * 1024;

/**
 * How long one live load attempt is given to produce its first picture.
 *
 * This is a *fixed* budget for the attempt, deliberately not extended by request activity. An
 * extendable deadline would reintroduce a defect already fixed here once: a source that keeps
 * serving playlists and fragments that never buffer would push the deadline out for ever and the
 * player would sit on the spinner instead of ever reporting a failure.
 *
 * The value is sized against measurement rather than taste. The stream this was diagnosed from
 * delivered its first fragment after 12.4 seconds (1.9 MB at 1.28 Mbps), so a 10-second deadline
 * could never have succeeded; 35 seconds leaves room for a source twice that slow while still
 * reporting a genuinely dead stream promptly.
 */
const LIVE_STARTUP_BUDGET_MS = 35_000;

/** How often the stalled-pipeline check runs. Kept coarse so it cannot flood the event ring. */
const LIVE_STALL_CHECK_MS = 5_000;


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
          if (isEmptyFragmentResponse(context.responseType, bytes.byteLength)) {
            callbacks.onError(
              {
                code: 204,
                text: "上游对分片请求返回了空响应（0 字节），该地址可能已失效。",
              },
              context,
              null,
              this.stats,
            );
            return;
          }
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

/**
 * The literal values of mpegts.js's `LoaderErrors`.
 *
 * Its typings declare `LoaderErrors` as an interface *and* use it as the parameter type of
 * `BaseLoader.onError`, which is not satisfiable: `LoaderErrors.EXCEPTION` has the literal type
 * `'Exception'`, which is not assignable to the interface. Indexing the interface recovers the union
 * the callbacks actually receive, so the class stays honest about what mpegts.js passes it.
 */
type MpegtsLoaderError = Mpegts.LoaderErrors[keyof Mpegts.LoaderErrors];

/**
 * Feeds mpegts.js from the Rust streaming command instead of the webview's own `fetch`.
 *
 * The webview cannot fetch these streams itself. The desktop runtime proxies media through Rust
 * precisely because these hosts cannot be relied on for CORS headers, and Rust also keeps the
 * request behind the project's public-URL, header, redirect and DNS policy, which a direct `fetch`
 * would bypass. This mirrors what the hls.js path already does with `TauriMediaLoader`.
 *
 * `mpegts.js` drives a loader through `Mpegts.BaseLoader`: it assigns the callbacks after
 * construction and then calls `open`. Chunks are pushed in arrival order with the stream offset they
 * begin at, which is load-bearing — a wrong `byteStart` misplaces timestamps rather than merely
 * logging oddly. `onComplete` is never called for a live stream, because a live stream does not end.
 */
class TauriFlvLoader {
  /** `true` for a streaming loader: mpegts.js only disables its stash buffer for range loaders. */
  readonly _needStash = true;
  _status: number = Mpegts.LoaderStatus.kIdle;

  onContentLengthKnown: (contentLength: number) => void = () => {};
  onURLRedirect: (redirectedURL: string) => void = () => {};
  onDataArrival: (
    chunk: ArrayBuffer,
    byteStart: number,
    receivedLength?: number,
  ) => void = () => {};
  onError: (
    errorType: MpegtsLoaderError,
    errorInfo: Mpegts.LoaderErrorMessage,
  ) => void = () => {};
  onComplete: (rangeFrom: number, rangeTo: number) => void = () => {};

  /** Request headers for the current source, refreshed by the player on every channel switch. */
  requestHeaders: Record<string, string> = {};

  private readonly streamId: string;
  private cancelStream: (() => Promise<void>) | null = null;
  private received = 0;
  private aborted = false;

  constructor(
    _seekHandler: unknown,
    private readonly config: Mpegts.Config,
  ) {
    // Unique per loader so a cancelled stream can never cancel a later one: mpegts.js builds a new
    // loader on every reconnect, and a shared id would make the registry's single flag ambiguous.
    this.streamId = `flv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  get type() {
    return "tauri-flv-loader";
  }

  get status() {
    return this._status;
  }

  get needStashBuffer() {
    return this._needStash;
  }

  /** Reported in mpegts.js's statistics; it reads this unconditionally on a live stream. */
  get currentSpeed() {
    return 0;
  }

  isWorking() {
    return (
      this._status === Mpegts.LoaderStatus.kConnecting ||
      this._status === Mpegts.LoaderStatus.kBuffering
    );
  }

  open(dataSource: Mpegts.MediaSegment) {
    this._status = Mpegts.LoaderStatus.kConnecting;
    const url = dataSource.url ?? "";
    const headers = {
      ...((this.config.headers as Record<string, string> | undefined) ?? {}),
      ...this.requestHeaders,
    };
    void streamMediaResource(
      this.streamId,
      url,
      headers,
      (chunk) => {
        if (this.aborted) return;
        this._status = Mpegts.LoaderStatus.kBuffering;
        const byteStart = this.received;
        this.received += chunk.byteLength;
        this.onDataArrival(
          chunk.buffer.slice(
            chunk.byteOffset,
            chunk.byteOffset + chunk.byteLength,
          ) as ArrayBuffer,
          byteStart,
          this.received,
        );
      },
      (meta: MediaStreamMeta) => {
        if (meta.url && meta.url !== url) this.onURLRedirect(meta.url);
      },
      (message) => {
        if (this.aborted) return;
        this._status = Mpegts.LoaderStatus.kError;
        // `Exception` is the loader-level class for a transport failure; mpegts.js maps it to its
        // own `NetworkError` type for the player, so reporting the player-level type here would
        // describe a stage that has not run yet.
        this.onError(Mpegts.LoaderErrors.EXCEPTION, { code: 0, msg: message });
      },
    )
      .then((handle) => {
        if (!handle) {
          this._status = Mpegts.LoaderStatus.kError;
          this.onError(Mpegts.LoaderErrors.EXCEPTION, {
            code: 0,
            msg: "桌面运行时未提供媒体流通道",
          });
          return;
        }
        // An abort that arrives before the handle exists must still stop the stream, so the intent
        // is applied as soon as the handle is available rather than being lost.
        if (this.aborted) {
          void handle.cancel();
          return;
        }
        this.cancelStream = handle.cancel;
      })
      .catch((error: unknown) => {
        if (this.aborted) return;
        this._status = Mpegts.LoaderStatus.kError;
        this.onError(Mpegts.LoaderErrors.EXCEPTION, {
          code: 0,
          msg: error instanceof Error ? error.message : String(error),
        });
      });
  }

  abort() {
    this.aborted = true;
    this._status = Mpegts.LoaderStatus.kIdle;
    void this.cancelStream?.();
    this.cancelStream = null;
  }

  destroy() {
    this.abort();
    this.onContentLengthKnown = () => {};
    this.onURLRedirect = () => {};
    this.onDataArrival = () => {};
    this.onError = () => {};
    this.onComplete = () => {};
  }
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
  return resolveMediaPipeline(source.kind, source.isLive, source.url) === "hls";
}

function isFlvSource(source: MediaSourceState) {
  return resolveMediaPipeline(source.kind, source.isLive, source.url) === "flv";
}

export function MediaPlayer({
  title,
  url,
  kind,
  isLive = false,
  fill = false,
  headers,
  poster,
  resumeAt = 0,
  onProgress,
  onStatus,
  onDiagnostic,
  onPlayable,
}: MediaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  /** Whether the player can be driven yet; shared by every pipeline, so it lives in a ref. */
  const playerReadyRef = useRef(false);
  /** The current pipeline's handlers, installed by the pipeline effect. See `MediaPipelineEvents`. */
  const pipelineEventsRef = useRef<MediaPipelineEvents | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  /**
   * The mpegts.js instance, held in a ref rather than only in the effect's closure.
   *
   * The cleanup function is the only place that can stop the upstream stream, and a live response
   * never ends on its own: an instance left behind keeps downloading until the process exits. The
   * effect's local variable is not reachable from `cleanup`, so the instance has to be shared.
   */
  const mpegtsRef = useRef<Mpegts.Player | null>(null);
  const callbackRef = useRef({ onProgress, onStatus, onDiagnostic, onPlayable });
  const resumeRef = useRef(resumeAt);
  const recorderRef = useRef(createDiagnosticRecorder());
  const environmentRef = useRef<MediaEnvironmentReport | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  /**
   * Whether this player's view is off screen, readable at any moment.
   *
   * **The effect below cannot be the only reader of `viewActive`, and that is the defect this exists
   * for.** That effect pauses the element when the view goes away, but every path that *starts*
   * playback lives inside the pipeline effect's closure — the live retry timer, the FLV reconnect,
   * the HLS window refresh, `startLivePlayback`. Those read `viewActive` as captured on the render
   * that created them, and they fire from timers long afterwards. So a stream that was mid-recovery
   * when the user navigated away would call `play()` again behind a hidden pane, and audio kept
   * coming out of a page the user had left. Measured symptom: "切到别的页面之后，还能在后台听到直播
   * 播放的声音".
   *
   * A ref rather than state because these callbacks must see the value *now*, not the value from
   * their render, and none of them should cause a re-render.
   */
  const viewAwayRef = useRef(false);
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
  // Playback has actually produced a picture. Until then the live surface stays covered by
  // the loading layer below, so the user never sees a bare Plyr control strip floating on an
  // empty black pane — which read as "the player is only ever this small".
  const [hasStarted, setHasStarted] = useState(false);
  /**
   * What container the address actually serves, once it has been measured.
   *
   * Null means "not measured", which is not the same as "not FLV": the pipeline decision must not
   * treat an absent measurement as evidence either way.
   */
  const [containerEvidence, setContainerEvidence] =
    useState<MediaContainerEvidence | null>(null);

  const pipeline = resolveMediaPipeline(kind, isLive, url, containerEvidence);
  /**
   * Whether the view this player lives in is on screen.
   *
   * The views are kept alive while the user is elsewhere (see `ViewPane`), which is what preserves
   * the library's search and the live workspace's channel. A *player* must not be kept alive with
   * them: a hidden live stream keeps downloading until the process exits, and a hidden VOD keeps
   * buffering. So playback is paused while the view is away and resumed when it comes back — the
   * pipeline, the position and the buffered data all survive, because nothing is torn down.
   */
  const viewActive = useViewActive();

  useEffect(() => {
    callbackRef.current = { onProgress, onStatus, onDiagnostic, onPlayable };
    resumeRef.current = resumeAt;
  }, [onDiagnostic, onPlayable, onProgress, onStatus, resumeAt]);

  /**
   * Measures the container before trusting the URL, for the addresses where the URL says nothing.
   *
   * Only the ambiguous case is measured (`shouldProbeContainer`): an address that already declares
   * itself as `.m3u8`, `.mp4` or `.flv` needs no round trip. The probe is deliberately *not* awaited
   * before playback starts — the measured cost on the real channel is ~1.6 s, and making every live
   * channel wait that long to confirm what it already claimed would be a regression for the many
   * that are genuinely HLS. Playback therefore begins on the URL-derived guess and is rebuilt only
   * if the measurement contradicts it, which the `pipeline` dependency below takes care of.
   */
  useEffect(() => {
    if (!shouldProbeContainer(kind, isLive, url)) return;
    let cancelled = false;
    setContainerEvidence(null);
    void probeMediaContainer(url, headers)
      .then((probe) => {
        if (cancelled || !probe) return;
        recorderRef.current.push(
          "媒体容器探测",
          `${probe.container} · ${probe.message} · 最终地址 ${truncateForDiagnostics(probe.url)}`,
        );
        setContainerEvidence({ container: probe.container, url: probe.url });
      })
      .catch(() => {
        // A failed probe is not a playback failure: the URL-derived pipeline is still a valid
        // guess, and the player reports any real problem through its own events.
      });
    return () => {
      cancelled = true;
    };
  }, [headers, isLive, kind, url]);

  useEffect(() => {
    const source = { url, kind, isLive, headers, poster };
    sourceRef.current = source;
    loadSourceRef.current?.(source);
  }, [headers, isLive, kind, poster, url]);

  /**
   * The player instance belongs to the element, not to the pipeline: it is created by whichever
   * pipeline boots first and destroyed here, with the component. See `MediaPipelineEvents` for what
   * rebuilding it in between actually does.
   */
  useEffect(
    () => () => {
      playerRef.current?.destroy();
      playerRef.current = null;
      playerReadyRef.current = false;
      pipelineEventsRef.current = null;
    },
    [],
  );

  /**
   * Stops playback while this player's view is off screen, and picks it up again on return.
   *
   * Kept alive, a hidden live stream downloads for as long as the app is open, and a hidden VOD
   * buffers ahead of a user who is not watching. Pausing is enough to stop both: hls.js and
   * mpegts.js stop fetching when the element is paused, and the pipeline keeps its buffered data and
   * position, so returning resumes where the user left rather than reloading.
   *
   * `autoResumeRef` remembers whether it was actually playing, so a view the user had deliberately
   * paused is not started by navigating back to it.
   *
   * **`viewAwayRef` is what makes this hold.** Pausing once is not enough on its own: the live
   * pipeline's own recovery paths (`startLivePlayback`, the FLV reconnect, the HLS window refresh)
   * fire from timers and would start the element again behind a hidden pane. They consult this ref
   * before playing, and the pipeline effect also reacts to it by cancelling the pending recovery
   * timers — see `livePausedByView`.
   */
  const autoResumeRef = useRef(false);
  /**
   * Set when the view returns and a live stream was playing before it left.
   *
   * **Why returning needs its own path rather than just `play()`.** A live element paused for a while
   * comes back with a stale buffer: the media it holds is seconds to minutes behind the live edge,
   * and hls.js and mpegts.js have both stopped fetching. Calling `play()` alone therefore resumes an
   * old fragment and then stalls — the "回来之后每次都要刷新" reported alongside it. The pipeline has to
   * be told to catch up, and only the pipeline effect knows how, so this flag is what hands the
   * decision to it through `liveResumeRef`.
   *
   * A ref because the pipeline effect must not re-run when it changes: re-running it tears down and
   * rebuilds the player, which is the defect that effect exists to avoid.
   */
  const resumeLiveRef = useRef(false);
  /** Installed by the pipeline effect; rejoins the live edge for the currently attached pipeline. */
  const liveResumeRef = useRef<(() => void) | null>(null);
  /**
   * Set when a recovery path tore the pipeline down but declined to rebuild it because the view was
   * away.
   *
   * **Without this, returning to an FLV channel would show a black pane.** Both live recovery paths
   * call their teardown *before* the deferred rebuild — `hls.stopLoad()`, `mpegts.unload()` — and the
   * away-guard then skips only the rebuild. So the pipeline is left stopped, and resuming has to know
   * that, because for mpegts.js nothing else re-issues the request: hls.js gets `startLoad(-1)` from
   * `seekToLiveEdge`, but the FLV loader needs an explicit `load()`.
   */
  const pipelineStoppedByViewRef = useRef(false);
  /**
   * The current pipeline's `armStartupWatchdog`, so the resume path can restart the deadline.
   *
   * The watchdog lives inside each pipeline branch and refuses to start while the view is away, so a
   * load that began during the absence is left with no deadline. Re-arming it on return is what keeps
   * a genuinely dead stream from sitting on the spinner for ever.
   */
  const armStartupWatchdogRef = useRef<(() => void) | null>(null);
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  useEffect(() => {
    viewAwayRef.current = !viewActive;
    const video = videoRef.current;
    if (!video) return;
    if (!viewActive) {
      autoResumeRef.current = !video.paused;
      if (!video.paused) video.pause();
      return;
    }
    if (!autoResumeRef.current) return;
    autoResumeRef.current = false;
    // Live is handed to the pipeline, which knows how to rejoin the live edge; `play()` alone would
    // resume a buffer that is already behind. VOD has no live edge to catch up to, so it resumes.
    if (isLiveRef.current) {
      resumeLiveRef.current = true;
      liveResumeRef.current?.();
      return;
    }
    void video.play().catch(() => {
      // A rejected play() is normal here: the element may still be waiting for data, and the live
      // path has its own retry policy that owns this decision (`requestLivePlayback`).
    });
  }, [viewActive]);

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
    let hasBufferedFragment = false;
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
      // A success clears the failure text. Without this, a recovery that succeeded after the
      // watchdog had already given up left the page still holding "直播流长时间没有收到可播放分片"
      // while the picture was playing — the diagnostic report then contradicted itself, saying
      // 播放状态：正在播放 and 失败信息：无 next to a stale 前置提示.
      const isFailure = !clearsFailureNote(nextStatus);
      lastMessage = isFailure ? (message ?? null) : null;
      if (liveMode && isFailure) setIsBuffering(false);
      if (isFailure) setHasFailed(true);
      if (nextStatus === "playing") {
        setHasFailed(false);
        setHasStarted(true);
      }
      recorder.push(`播放状态：${mediaStatusLabels[nextStatus]}`, message);
      callbackRef.current.onStatus?.(nextStatus, isFailure ? message : undefined);
      scheduleDiagnosticFlush(isFailure);
    };

    /**
     * Runs once per pipeline, and *only* installs the handlers this pipeline wants the player to
     * call. The player itself may already exist — it belongs to the element, and every pipeline
     * change (a probe contradicting the URL-derived guess is the routine one for live channels)
     * must leave it standing.
     */
    const installPipelineEvents = (events: MediaPipelineEvents) => {
      pipelineEventsRef.current = events;
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

    /**
     * Builds the player if it does not exist yet, and otherwise leaves the existing one alone.
     *
     * Its listeners are bound once, here, and dispatch through `pipelineEventsRef` — see
     * `MediaPipelineEvents` for why a second Plyr on this element is not an option.
     */
    const ensurePlayer = () => {
      const existing = playerRef.current;
      if (existing) {
        if (liveMode) playerReadyRef.current = true;
        return existing;
      }
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
      playerRef.current = player;
      if (liveMode) {
        // HLS live playback can buffer before Plyr emits its ready event.
        // The media element is the source of truth for starting playback.
        playerReadyRef.current = true;
      }
      player.on("ready", () => {
        playerReadyRef.current = true;
        const resume = resumeRef.current;
        if (
          resume > 5 &&
          Number.isFinite(player.duration) &&
          player.duration > resume
        ) {
          player.currentTime = resume;
        }
        pipelineEventsRef.current?.onReady();
      });
      player.on("play", () => pipelineEventsRef.current?.onPlay());
      player.on("playing", () => pipelineEventsRef.current?.onPlaying());
      player.on("waiting", () => pipelineEventsRef.current?.onWaiting());
      player.on("stalled", () => pipelineEventsRef.current?.onStalled());
      player.on("pause", () => pipelineEventsRef.current?.onPause());
      player.on("ended", () => pipelineEventsRef.current?.onEnded());
      player.on("error", () => pipelineEventsRef.current?.onError());
      player.on("timeupdate", () => {
        pipelineEventsRef.current?.onTimeUpdate(player.currentTime);
      });
      return player;
    };

    const requestLivePlayback = async () => {
      const player = playerRef.current;
      if (
        !liveMode ||
        !player ||
        !hasBufferedFragment ||
        !playerReadyRef.current ||
        !playbackRequested ||
        playbackAttemptInFlight ||
        // Never start playback for a view the user has left. Without this the retry timer below
        // happily restarted a hidden stream, which is how audio kept playing from a page the user
        // had navigated away from.
        viewAwayRef.current ||
        disposed
      ) {
        return;
      }
      const attemptVersion = sourceVersion;
      playbackAttemptInFlight = true;
      const started = await startLivePlayback(player, video, () => {
        // Recorded rather than applied silently. The player has gone quiet, and the user needs to know
        // it was the webview refusing a sounding start rather than the app choosing to mute them —
        // which is what the reported "为什么默认静音" was really about.
        //
        // No `report()` call: the status vocabulary has no "muted", and inventing one would have to be
        // added to `MediaStatus` and to every reader of it for a note the diagnostic ring already
        // carries. Playback continues, so the status is still whatever it was.
        recorder.push("自动播放被拒绝", "改为静音播放；点击音量图标可打开声音");
        scheduleDiagnosticFlush(true);
      });
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
        !playerRef.current ||
        !hasBufferedFragment ||
        !playerReadyRef.current ||
        !playbackRequested ||
        disposed
      ) {
        return;
      }
      void requestLivePlayback();
    };

    /**
     * Rejoins the live edge after the view comes back.
     *
     * Live media cannot simply be resumed. While the pane was hidden the element was paused, so the
     * libraries stopped fetching, and what the buffer holds is however far behind the live edge the
     * pause left it — seconds for a short absence, minutes for a long one. Playing that buffer shows
     * old content and then stalls. So the pipeline is asked to re-seek to the live edge (hls.js) or
     * to flush the stale transmuxer buffer (mpegts.js) before playback resumes.
     *
     * Installed for every pipeline rather than per-branch: each branch overwrites it, and the flag is
     * cleared here so a resume request cannot be served twice.
     */
    liveResumeRef.current = () => {
      if (!liveMode || disposed) return;
      if (!resumeLiveRef.current) return;
      resumeLiveRef.current = false;
      recorder.push("视图返回", "重新对齐直播进度");
      scheduleDiagnosticFlush(true);
      // A recovery that was cut short by the navigation left the pipeline stopped. mpegts.js has to be
      // told to load again — it has no equivalent of `startLoad` and will not restart on its own —
      // whereas hls.js is restarted by `seekToLiveEdge` below.
      const flv = mpegtsRef.current;
      if (pipelineStoppedByViewRef.current && flv) {
        pipelineStoppedByViewRef.current = false;
        recorder.push("恢复 FLV 直播流", "视图返回后重新装载");
        flv.load();
      } else {
        pipelineStoppedByViewRef.current = false;
      }
      seekToLiveEdge(video, hlsRef.current);
      // The element was paused, so the libraries are not fetching. A paused element does not resume
      // its own loading, and the retry path is what re-issues the request once data arrives.
      //
      // `hasBufferedFragment` is deliberately not set here. It means "the pipeline has data now", and
      // claiming it would let `requestLivePlayback` play an element with nothing to show — the very
      // state the flag exists to prevent. Each pipeline sets it truthfully when its own data arrives
      // (`markFlvBuffered`, the HLS `FRAG_BUFFERED` handler), and that is what starts playback.
      playbackRequested = true;
      // **The startup deadline has to be re-armed, not merely restarted.** Both watchdogs decline to
      // start while the view is away (see `armStartupWatchdog`), so a load that began during the
      // absence has no deadline at all. Without this the pipeline would be given no verdict either
      // way: a genuinely dead stream would sit on the spinner for ever instead of reporting.
      armStartupWatchdogRef.current?.();
      void requestLivePlayback();
    };

    // This pipeline's half of the player's events. Everything the player reports lands here, in the
    // pipeline that is *currently* attached — the handlers close over this effect's state, which is
    // exactly why they are reached through a ref rather than bound to the player once.
    installPipelineEvents({
      onReady: () => {
        if (!liveMode) report("ready");
        startBufferedLivePlayback();
      },
      onPlay: () => {
        recorder.push("媒体元素开始播放请求");
        if (liveMode) {
          playbackRequested = true;
          setIsBuffering(true);
        }
      },
      onPlaying: () => {
        playbackRequested = false;
        playbackAttempts = 0;
        setIsBuffering(false);
        report("playing");
      },
      onWaiting: () => {
        recorder.push("缓冲等待");
        scheduleDiagnosticFlush();
        if (liveMode) setIsBuffering(true);
      },
      onStalled: () => {
        recorder.push("数据停滞", `networkState=${video.networkState}`);
        scheduleDiagnosticFlush();
        if (liveMode) setIsBuffering(true);
      },
      onPause: () => {
        if (!liveMode) report("paused");
      },
      onEnded: () => {
        if (!liveMode) report("ended");
      },
      onError: () => {
        const mediaError = video.error;
        report(
          "error",
          mediaError
            ? `媒体元素解码失败（code ${mediaError.code}：${mediaError.message || "无详细信息"}）。`
            : "Plyr 无法播放当前媒体地址。",
        );
      },
      onTimeUpdate: (currentTime) => {
        if (Number.isFinite(currentTime) && currentTime - lastProgress >= 5) {
          lastProgress = currentTime;
          callbackRef.current.onProgress?.(currentTime);
        }
      },
    });

    // A pipeline the user has moved on from does not get to keep its verdict on screen. This
    // effect runs again exactly when the pipeline changes, and for a live address that says nothing
    // about its container the *first* pipeline is a guess: hls.js rejects an FLV as "not a valid
    // HLS playlist", which is a true statement about a pipeline that is about to be replaced by the
    // one that actually plays the stream. Without this the user saw 无法播放当前内容 for the ~1.2 s
    // between the probe answering and the picture starting, on a channel that was about to work.
    setHasFailed(false);
    if (!liveMode) report("loading");
    video.poster = initialSource.poster ?? "";

    // Playability is reported from the media element, not from Plyr's `ready` event. `ready`
    // only means Plyr finished building its DOM, which happens before any media is fetched, so
    // a caller gating on it would reveal a working-looking player for a URL that is about to
    // fail. `canplay`/`loadeddata` mean the element actually has decodable data.
    let playableReported = false;
    const announcePlayable = () => {
      if (playableReported || disposed) return;
      playableReported = true;
      recorder.push(
        "媒体已可播放",
        `readyState=${video.readyState} networkState=${video.networkState}`,
      );
      callbackRef.current.onPlayable?.();
      scheduleDiagnosticFlush(true);
    };
    video.addEventListener("canplay", announcePlayable);
    video.addEventListener("loadeddata", announcePlayable);

    // `crossOrigin` is deliberately left unset. Setting it makes the element demand CORS
    // headers from the media host, which can only break the native path (a live mp4 or a VOD
    // file) and buys nothing: nothing here reads pixels back through canvas, captureStream,
    // or WebAudio, and the HLS path feeds the element from a same-origin MediaSource blob.
    //
    // **Live is not muted up front, and it used to be.** `video.muted = liveMode` made every channel
    // start silent with its volume slider already down, which reads as a broken player rather than a
    // policy — the reported "播放器默认静音了，这个很奇怪". The mute was there to satisfy the browser
    // autoplay rule, which refuses a *sounding* `play()` for media the user did not explicitly start.
    // That rule does not apply here: this is a desktop webview playing media the user just selected by
    // clicking a channel, and `startLivePlayback` already contains the mute-and-retry fallback for the
    // case where the element does refuse. Pre-muting therefore bought nothing and silenced every
    // stream — the fallback is what handles a refusal, and it now tells the user it did.
    video.autoplay = liveMode;
    video.defaultMuted = false;
    video.muted = false;
    video.preload = "auto";
    const isHls = pipeline === "hls";
    const isFlv = pipeline === "flv";
    if (isFlv && Mpegts.isSupported()) {
      let flvRecoveryAttempts = 0;
      /** When the loader last delivered bytes. See `flvRequestInFlight`. */
      let lastChunkAt = 0;
      /**
       * Whether the stream is still delivering.
       *
       * mpegts.js exposes no per-chunk in-flight signal the way hls.js does, so the equivalent is
       * derived from arrival time: a stream that produced bytes within the last stall-check window
       * is slow, not dead. This is what keeps the shared `decideLiveWatchdog` rule honest for this
       * pipeline — the defect it exists to prevent (a watchdog cancelling a request that was still
       * downloading, then blaming the source) applies here identically.
       */
      const flvRequestInFlight = () => Date.now() - lastChunkAt < LIVE_STALL_CHECK_MS;

      const markFlvBuffered = () => {
        flvRecoveryAttempts = 0;
        hasBufferedFragment = true;
        if (startupWatchdog !== null) {
          clearTimeout(startupWatchdog);
          startupWatchdog = null;
        }
        startBufferedLivePlayback();
      };

      let startupDeadlineAt = 0;
      /**
       * Starts the startup deadline for this load attempt.
       *
       * **A watchdog that keeps counting while the pane is hidden judges a stream on time it was not
       * being asked to play.** The element is paused and the loaders are stopped, so no fragment can
       * arrive and the fixed budget expires however healthy the stream is. Recovery then ran behind a
       * hidden pane, and the user returned to a channel already declared dead and reconnecting — the
       * "回来之后每次都要刷新" half of the report. The deadline therefore only starts while someone is
       * watching, and `liveResumeRef` re-arms it when the view returns.
       */
      const armStartupWatchdog = () => {
        if (!liveMode || disposed || hasBufferedFragment) return;
        // Nothing to judge while nobody is watching.
        if (viewAwayRef.current) return;
        if (startupWatchdog !== null) clearTimeout(startupWatchdog);
        startupDeadlineAt = Date.now() + LIVE_STARTUP_BUDGET_MS;
        startupWatchdog = setTimeout(function check() {
          startupWatchdog = null;
          if (disposed) return;
          // The user left while this timer was pending. Returning without a verdict is the point: the
          // stream was never given a fair chance, so it must not be judged.
          if (viewAwayRef.current) return;
          const decision = decideLiveWatchdog({
            hasBufferedFragment,
            requestInFlight: flvRequestInFlight(),
            now: Date.now(),
            deadlineAt: startupDeadlineAt,
          });
          if (decision === "stop") return;
          const waited = LIVE_STARTUP_BUDGET_MS - (startupDeadlineAt - Date.now());
          if (decision === "postpone") {
            recorder.push(
              "看门狗推迟",
              `FLV 流仍在传输，已等待 ${Math.round(waited / 1000)} 秒`,
            );
            scheduleDiagnosticFlush();
            startupWatchdog = setTimeout(check, LIVE_STALL_CHECK_MS);
            return;
          }
          recorder.push(
            "启动看门狗触发",
            `${Math.round(waited / 1000)} 秒内没有可播放的画面`,
          );
          if (!recoverFlvStream()) {
            report(
              "error",
              "FLV 直播流长时间没有可播放的画面，请切换频道或稍后重试。",
            );
          }
        }, LIVE_STALL_CHECK_MS);
      };
      armStartupWatchdogRef.current = armStartupWatchdog;
      function recoverFlvStream() {
        const instance = mpegtsRef.current;
        if (
          !liveMode ||
          flvRecoveryAttempts >= 2 ||
          disposed ||
          liveRecoveryTimer !== null ||
          !instance
        ) {
          return false;
        }
        flvRecoveryAttempts += 1;
        playbackRequested = true;
        playbackAttempts = 0;
        hasBufferedFragment = false;
        lastChunkAt = Date.now();
        recorder.push("尝试重连 FLV 直播流", `第 ${flvRecoveryAttempts} 次`);
        scheduleDiagnosticFlush(true);
        // `unload` then `load` is mpegts.js's own reconnect path: it tears the transmuxer down and
        // builds a fresh loader, which is what actually re-issues the request.
        instance.unload();
        // The teardown has already happened, so the pipeline is stopped from here on. If the view is
        // away when the rebuild comes due, that fact has to outlive this closure's return, because
        // returning to the view must call `load()` again — unlike hls.js, mpegts.js will not restart
        // on its own.
        pipelineStoppedByViewRef.current = true;
        liveRecoveryTimer = setTimeout(() => {
          liveRecoveryTimer = null;
          if (disposed) return;
          // A view the user has left is not asked to reconnect: mpegts.js's `load()` immediately
          // starts fetching again, so reconnecting behind a hidden pane would resume both the
          // download and the audio. Returning while paused keeps the pipeline otherwise intact.
          if (viewAwayRef.current) return;
          instance.load();
          void Promise.resolve(instance.play()).catch(() => {});
          armStartupWatchdog();
        }, 600);
        return true;
      }

      const createFlvPlayerNow = () => {
        const config: Mpegts.Config = {
          // Deliberately on the main thread. The project already measured that a blob-URL worker is
          // the CSP-sensitive path here (the black live screen was a refused `worker-src blob:`),
          // and mpegts.js falls back to inline transmuxing internally with no signal the caller can
          // observe — so a refusal would be silent. FLV transmuxing is light enough that the
          // deterministic choice costs nothing measurable.
          enableWorker: false,
          isLive: liveMode,
          // A live FLV stream has no meaningful seek, and its timestamps start near zero rather
          // than at a wall clock, so latency chasing would fight the source instead of the buffer.
          liveBufferLatencyChasing: false,
          // The loader already owns the request, so mpegts.js must not add its own headers on top.
          headers: sourceRef.current.headers,
          customLoader: TauriFlvLoader as unknown as Mpegts.CustomLoaderConstructor,
        };
        const instance = Mpegts.createPlayer(
          { type: "flv", isLive: liveMode, url: sourceRef.current.url },
          config,
        );
        mpegtsRef.current = instance;
        pipelineMode = "flv-mpegts";
        lastChunkAt = Date.now();
        recorder.push("创建 mpegts.js 实例", "type=flv · HTTP-FLV 转封装");
        instance.on(Mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
          recorder.push("FLV 播放错误", describeMpegtsError(errorType, errorDetail, errorInfo));
          if (liveMode && recoverFlvStream()) return;
          report("error", formatMpegtsError(errorType, errorDetail, errorInfo));
        });
        instance.on(Mpegts.Events.MEDIA_INFO, (mediaInfo: unknown) => {
          recorder.push("FLV 媒体信息", truncateForDiagnostics(JSON.stringify(mediaInfo)));
          markFlvBuffered();
        });
        // The loader is the only place that sees raw arrivals, so byte progress is recorded from
        // the media element's own buffered range instead of a chunk callback.
        instance.on(Mpegts.Events.STATISTICS_INFO, (statistics: unknown) => {
          lastChunkAt = Date.now();
          const speed = (statistics as { speed?: number } | null)?.speed;
          if (typeof speed === "number" && speed > 0) {
            recorder.push("FLV 传输速率", `${Math.round(speed)} KB/s`);
          }
        });
        ensurePlayer();
        instance.attachMediaElement(video);
        instance.load();
        // A rejected play() is expected before the element has data; `startLivePlayback` below owns
        // the retry policy, exactly as it does for HLS.
        void Promise.resolve(instance.play()).catch(() => {});
        return instance;
      };

      const restartFlvPipeline = () => {
        const previous = mpegtsRef.current;
        if (liveRecoveryTimer !== null) {
          clearTimeout(liveRecoveryTimer);
          liveRecoveryTimer = null;
        }
        if (startupWatchdog !== null) {
          clearTimeout(startupWatchdog);
          startupWatchdog = null;
        }
        hasBufferedFragment = false;
        flvRecoveryAttempts = 0;
        playbackAttempts = 0;
        playbackAttemptInFlight = false;
        playbackRequested = liveMode;
        sourceVersion += 1;
        setIsBuffering(liveMode);
        previous?.destroy();
        mpegtsRef.current = null;      mpegtsRef.current = null;
        if (disposed) return;
        createFlvPlayerNow();
        armStartupWatchdog();
      };

      pipelineMode = "flv-mpegts";
      armStartupWatchdog();
      scheduleBoot(createFlvPlayerNow);
      retryRef.current = () => {
        setHasFailed(false);
        status = "loading";
        lastMessage = null;
        recorder.push("用户重试", "重新装载当前地址");
        restartFlvPipeline();
      };
      loadSourceRef.current = (source) => {
        const instance = mpegtsRef.current;
        if (!instance || resolveMediaPipeline(source.kind, source.isLive, source.url) !== "flv") {
          return;
        }
        if (liveRecoveryTimer !== null) {
          clearTimeout(liveRecoveryTimer);
          liveRecoveryTimer = null;
        }
        if (startupWatchdog !== null) {
          clearTimeout(startupWatchdog);
          startupWatchdog = null;
        }
        flvRecoveryAttempts = 0;
        sourceVersion += 1;
        playbackAttempts = 0;
        playbackAttemptInFlight = false;
        hasBufferedFragment = false;
        playbackRequested = source.isLive;
        setIsBuffering(source.isLive);
        setHasFailed(false);
        video.poster = source.poster ?? "";
        recorder.push("切换播放地址", truncateForDiagnostics(source.url));
        // mpegts.js has no "change the address" call: the data source is fixed at construction, so
        // a switch rebuilds the instance. `restartFlvPipeline` is exactly that path.
        restartFlvPipeline();
        scheduleDiagnosticFlush(true);
      };
    } else if (isFlv) {
      report(
        "error",
        "当前运行环境不支持 FLV 转封装播放（需要 Media Source Extensions），无法播放该频道。",
      );
    } else if (isHls && Hls.isSupported()) {
      let hls: Hls | null = null;
      let liveRecoveryAttempts = 0;
      let workerFallbackUsed = false;

      const markMediaBuffered = () => {
        liveRecoveryAttempts = 0;
        hasBufferedFragment = true;
        if (startupWatchdog !== null) {
          clearTimeout(startupWatchdog);
          startupWatchdog = null;
        }
        startBufferedLivePlayback();
      };
      /**
       * Whether a fragment request is currently outstanding.
       *
       * This is what makes the watchdog safe to run at all. It used to fire a flat 10 seconds after
       * `armStartupWatchdog`, with no idea whether the pipeline was stalled or merely slow, and its
       * recovery called `stopLoad()` — which aborts the in-flight request. On the stream this was
       * diagnosed from, each fragment took 12.4 seconds, so the watchdog cancelled every request
       * about 2.4 seconds before it would have arrived, then blamed the source and showed a failure
       * overlay. The third attempt was never cancelled because the recovery budget had run out, it
       * arrived normally, and playback started — which is exactly the "it said it failed and then
       * started playing by itself" the user saw.
       */
      let fragmentRequestInFlight = false;
      /**
       * The deadline for the current load attempt. Fixed, not extended by request activity: see
       * `LIVE_STARTUP_BUDGET_MS`.
       */
      let startupDeadlineAt = 0;
      /**
       * Starts the startup deadline for this load attempt.
       *
       * The same rule as the FLV watchdog above: a paused element cannot produce a fragment, so
       * counting against it while the pane is hidden would fail a healthy stream and send the user
       * back to a channel that was already reconnecting.
       */
      const armStartupWatchdog = () => {
        if (!liveMode || disposed || hasBufferedFragment) return;
        // Nothing to judge while nobody is watching.
        if (viewAwayRef.current) return;
        if (startupWatchdog !== null) clearTimeout(startupWatchdog);
        startupDeadlineAt = Date.now() + LIVE_STARTUP_BUDGET_MS;
        startupWatchdog = setTimeout(function check() {
          startupWatchdog = null;
          if (disposed) return;
          // The user left while this timer was pending. Returning without a verdict is the point: the
          // stream was never given a fair chance, so it must not be judged.
          if (viewAwayRef.current) return;
          const decision = decideLiveWatchdog({
            hasBufferedFragment,
            requestInFlight: fragmentRequestInFlight,
            now: Date.now(),
            deadlineAt: startupDeadlineAt,
          });
          if (decision === "stop") return;
          const waited = LIVE_STARTUP_BUDGET_MS - (startupDeadlineAt - Date.now());
          if (decision === "postpone") {
            recorder.push(
              "看门狗推迟",
              `分片仍在下载，已等待 ${Math.round(waited / 1000)} 秒`,
            );
            scheduleDiagnosticFlush();
            startupWatchdog = setTimeout(check, LIVE_STALL_CHECK_MS);
            return;
          }
          recorder.push(
            "启动看门狗触发",
            `${Math.round(waited / 1000)} 秒内没有可播放的画面`,
          );
          if (!recoverLiveWindow()) {
            report(
              "error",
              "直播流长时间没有可播放的画面，请切换频道或稍后重试。",
            );
          }
        }, LIVE_STALL_CHECK_MS);
      };
      armStartupWatchdogRef.current = armStartupWatchdog;
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
          // Same rule as the FLV reconnect: `startLoad` would resume fetching for a view nobody is
          // looking at, and the stream would be audible again.
          if (viewAwayRef.current) return;
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
        // A fragment-level error settles the request that was in flight. Leaving the flag set
        // would make the watchdog believe a request is still running forever, and it would then
        // postpone until the loader's own timeout instead of recovering.
        if (
          [
            "fragLoadError",
            "fragLoadTimeOut",
            "fragParsingError",
            "fragLoadAborted",
            "bufferAppendError",
          ].includes(data.details)
        ) {
          fragmentRequestInFlight = false;
        }
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
          // From here until the fragment settles, a quiet pipeline is expected rather than
          // suspicious: a slow source is still delivering, and the loader's own timeout bounds it.
          fragmentRequestInFlight = true;
        });
        instance.on(Hls.Events.FRAG_LOADED, (_event, data) => {
          recorder.push(
            "分片已返回",
            `序号 ${data.frag?.sn ?? "未知"} · ${data.payload?.byteLength ?? 0} 字节`,
          );
          fragmentRequestInFlight = false;
        });
        instance.on(Hls.Events.MEDIA_ATTACHED, (_event, data) => {
          attachedMediaSource = data.mediaSource ?? null;
          recorder.push(
            "媒体元素已挂载 MediaSource",
            `readyState=${attachedMediaSource?.readyState ?? "未创建"}`,
          );
        });
        // Only a fragment that actually produced buffered media counts as progress.
        //
        // `BUFFER_APPENDED` was wired here too, but it fires even when the append contributed
        // nothing — including the empty-fragment case above — and it reset the recovery counter
        // every time. That made the live recovery loop endless: each cycle reported "尝试刷新
        // 直播窗口 第 1 次" and the counter never reached its limit, so the player stayed on the
        // loading spinner forever instead of ever reporting a failure. `FRAG_BUFFERED` means the
        // fragment was demuxed and buffered, which is the only signal worth treating as success.
        instance.on(Hls.Events.FRAG_BUFFERED, () => {
          fragmentRequestInFlight = false;
          markMediaBuffered();
        });
        instance.on(Hls.Events.ERROR, handleHlsError);
        ensurePlayer();
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
        // The old instance is destroyed below, so whatever it had in flight is gone with it.
        // Leaving this set would make the new attempt's watchdog wait for a request that will never
        // settle.
        fragmentRequestInFlight = false;
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
        // `loadSource` abandons whatever the previous address had in flight, so the outstanding
        // marker must not survive into the new source.
        fragmentRequestInFlight = false;
        playbackRequested = source.isLive;
        setIsBuffering(source.isLive);
        setHasFailed(false);
        video.poster = source.poster ?? "";
        recorder.push("切换播放地址", truncateForDiagnostics(source.url));
        instance.loadSource(source.url);
        instance.startLoad(-1);
        armStartupWatchdog();
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
        if (isHlsSource(source) || isFlvSource(source)) return;
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
        ensurePlayer();
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
      video.removeEventListener("canplay", announcePlayable);
      video.removeEventListener("loadeddata", announcePlayable);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      // A live FLV response never ends on its own, so this destroy is what actually stops the
      // upstream stream. Without it the Rust command would keep downloading into a webview that has
      // already navigated away.
      mpegtsRef.current?.destroy();
      mpegtsRef.current = null;
      // The player is deliberately *not* destroyed here. It belongs to the element, not to this
      // pipeline, and Plyr refuses to initialise an element twice — see `MediaPipelineEvents`.
      pipelineEventsRef.current = null;
      loadSourceRef.current = null;
      retryRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
    // Keyed on the pipeline rather than on `isLive` alone: a probed container can change the
    // pipeline for an address that stays the same, and each pipeline owns a different library
    // attached to the same <video> element — hls.js and mpegts.js both attach a MediaSource, and
    // neither can be swapped for the other without tearing the library down. The player around them
    // survives the change; that is the whole point of the split.
  }, [pipeline]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-black ring-1 ring-border/40",
        // The live workspace centres this wrapper inside a large flex container. Without an
        // explicit size it shrinks to the <video> element's intrinsic 300x150 box, so the
        // player rendered as a small stamp in the middle of the surface. `fill` makes it
        // occupy the whole pane; the natural aspect-ratio box stays for the VOD player,
        // where the wrapper sits in a normal document-flow column.
        //
        // `.plyr` is Plyr's own root and carries no height, so its
        // `.plyr__video-wrapper{height:100%}` resolves against auto and collapses to the
        // video's intrinsic 150px. Stretching that node is what actually makes the picture
        // fill the pane.
        fill && "h-full w-full [&_.plyr]:h-full",
      )}
      style={{ "--plyr-color-main": "var(--primary)" } as React.CSSProperties}
    >
      <video
        ref={videoRef}
        className={cn(
          fill ? "h-full w-full object-contain" : "aspect-video w-full",
          // Hide the untouched media element while the live pipeline is still connecting, so
          // only the loading layer below is visible on an otherwise empty black surface.
          isLive && !hasStarted && !hasFailed && "opacity-0",
        )}
        playsInline
      />
      {isLive && isBuffering && !hasStarted && !hasFailed && (
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black"
          aria-live="polite"
        >
          <span className="size-8 animate-spin rounded-full border-2 border-white/25 border-t-primary" />
          <p className="text-xs text-white/60">
            {title ? `正在连接 ${title}…` : "正在连接直播信号…"}
          </p>
        </div>
      )}
      {isLive && isBuffering && hasStarted && !hasFailed && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          aria-label="直播缓冲中"
        >
          <span className="size-8 animate-spin rounded-full border-2 border-white/25 border-t-primary" />
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
            具体环节见「播放诊断」。
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => retryRef.current?.()}
          >
            <RotateCw className="size-3.5" data-icon="inline-start" aria-hidden="true" />
            重试
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Moves a live element back to the live edge.
 *
 * A live element paused for a while comes back holding stale media: what is buffered is however far
 * behind the edge the pause left it. Playing that shows old content and then runs out, which is the
 * "回来之后要重新连接" experience. Seeking past the end of what is buffered makes the element discard
 * it and load the current segment instead — the standard way to rejoin a live edge, and the only one
 * that works for both an ordinary live element and one fed by hls.js or mpegts.js.
 *
 * `seekable` is preferred over `buffered` because it describes the range the element can seek within,
 * which for a live stream is the window the server still serves; `buffered` can be narrower and would
 * leave the element short of the edge. Both are guarded because a live element reports an empty range
 * before its first segment arrives, and `seekable.end(0)` on an empty range throws.
 */
function seekToLiveEdge(video: HTMLVideoElement, hls: Hls | null): void {
  try {
    const range = video.seekable.length > 0 ? video.seekable : video.buffered;
    if (range.length === 0) {
      // Nothing to align to yet. hls.js will pick the live edge itself when it starts loading again.
      if (hls) hls.startLoad(-1);
      return;
    }
    const edge = range.end(range.length - 1);
    if (Number.isFinite(edge) && edge > 0) {
      video.currentTime = edge;
    }
    // `startLoad(-1)` means "resume from the live edge" rather than from a stored position. Calling
    // it is what makes hls.js fetch again after the pause, which pausing the element alone does not
    // do for every stream type.
    if (hls) hls.startLoad(-1);
  } catch {
    // Seeking on a live element can throw while its ranges are being updated. The retry path that
    // follows still restarts playback, so failing to align is not worth reporting as an error.
  }
}

/**
 * Starts a live stream, falling back to muted playback if the element refuses to sound.
 *
 * The fallback is the only reason this is not a bare `video.play()`. A webview may refuse a sounding
 * `play()` for media it considers not explicitly started, and the remedy is to start muted — a stream
 * with no sound beats no stream at all. It is reported through `onMutedFallback` so the interface can
 * say so, because a player that goes quiet with no explanation is exactly the "为什么默认静音" the user
 * reported; the difference now is that it happens only when it has to, and it is stated.
 */
async function startLivePlayback(
  player: Plyr,
  video: HTMLVideoElement,
  onMutedFallback?: () => void,
): Promise<boolean> {
  try {
    await video.play();
    return true;
  } catch {
    video.muted = true;
    player.muted = true;
    onMutedFallback?.();
    try {
      await video.play();
      return true;
    } catch {
      return false;
    }
  }
}
