import type Hls from "hls.js";
import type { ErrorData } from "hls.js";

import type { MediaKind } from "@/types/moseek";

export type MediaStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export interface MediaDiagnosticEvent {
  at: number;
  label: string;
  detail?: string;
}

export interface MediaEnvironmentReport {
  tauriRuntime: boolean;
  mediaSourceSupported: boolean;
  hlsJsSupported: boolean;
  avcSupported: boolean;
  hevcSupported: boolean;
  aacSupported: boolean;
  transmuxWorkerSupported: boolean;
  transmuxWorkerNote: string;
  userAgent: string;
}

export interface MediaSnapshot {
  readyState: number;
  networkState: number;
  currentTime: number;
  paused: boolean;
  muted: boolean;
  videoWidth: number;
  videoHeight: number;
  buffered: string;
}

export interface MediaPipelineSnapshot {
  mode: "hls-worker" | "hls-inline" | "flv-mpegts" | "native";
  levelCount: number;
  currentLevel: number;
  loadLevel: number;
  mediaSourceState: string;
  bufferedSeconds: number;
}

export interface MediaDiagnosticSnapshot {
  status: MediaStatus;
  message: string | null;
  source: {
    url: string;
    kind: MediaKind;
    isLive: boolean;
    headers: Record<string, string>;
  };
  environment: MediaEnvironmentReport | null;
  media: MediaSnapshot;
  pipeline: MediaPipelineSnapshot;
  events: MediaDiagnosticEvent[];
}

/**
 * Whether hls.js can play here, asked of hls.js itself.
 *
 * The import is dynamic on purpose. A static `import Hls from "hls.js"` made this module depend
 * on the whole library, and because the diagnostic panel and the live view both import this
 * module, merely opening 播放诊断 pulled in ~700 kB of player code — the panel chunk was 730 kB.
 * Loading it lazily keeps the question answerable without the static dependency.
 *
 * Reimplementing `Hls.isSupported()` was the other option and was rejected: it does more than
 * check for MediaSource, also verifying SourceBuffer's API and that the browser can play one of
 * hls.js's baseline codecs. A hand-written approximation would report support for a browser that
 * cannot actually play, which is worse than the extra import.
 */
async function detectHlsJsSupport() {
  const { default: Hls } = await import("hls.js");
  return Hls.isSupported();
}

const workerProbeTimeoutMs = 800;

let environmentProbe: Promise<MediaEnvironmentReport> | null = null;

export function probeMediaEnvironment(): Promise<MediaEnvironmentReport> {
  if (!environmentProbe) {
    environmentProbe = runEnvironmentProbe();
  }
  return environmentProbe;
}

async function runEnvironmentProbe(): Promise<MediaEnvironmentReport> {
  const mediaSourceSupported = typeof MediaSource !== "undefined";
  const workerReport = await probeTransmuxWorker();
  return {
    tauriRuntime:
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
    mediaSourceSupported,
    hlsJsSupported: await detectHlsJsSupport(),
    avcSupported: isCodecSupported(
      mediaSourceSupported,
      'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
    ),
    hevcSupported: isCodecSupported(
      mediaSourceSupported,
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
    ),
    aacSupported: isCodecSupported(
      mediaSourceSupported,
      'audio/mp4; codecs="mp4a.40.2"',
    ),
    transmuxWorkerSupported: workerReport.supported,
    transmuxWorkerNote: workerReport.note,
    userAgent: typeof navigator === "undefined" ? "未知" : navigator.userAgent,
  };
}

function isCodecSupported(mediaSourceSupported: boolean, mimeType: string) {
  if (!mediaSourceSupported) return false;
  try {
    return MediaSource.isTypeSupported(mimeType);
  } catch {
    return false;
  }
}

async function probeTransmuxWorker(): Promise<{
  supported: boolean;
  note: string;
}> {
  if (typeof Worker === "undefined" || typeof Blob === "undefined") {
    return { supported: false, note: "当前运行环境不提供 Web Worker" };
  }
  let objectUrl: string | null = null;
  try {
    const blob = new Blob(
      ['self.onmessage=function(){self.postMessage("pong")}'],
      { type: "text/javascript" },
    );
    objectUrl = URL.createObjectURL(blob);
    const worker = new Worker(objectUrl);
    const supported = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), workerProbeTimeoutMs);
      worker.onmessage = () => {
        clearTimeout(timer);
        resolve(true);
      };
      worker.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      worker.postMessage("ping");
    });
    worker.terminate();
    return {
      supported,
      note: supported
        ? "转封装线程可用"
        : "转封装线程被拒绝，通常是 CSP 缺少 worker-src blob:",
    };
  } catch (error) {
    return {
      supported: false,
      note: `转封装线程创建失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export function createDiagnosticRecorder(limit = 60) {
  const events: MediaDiagnosticEvent[] = [];
  return {
    push(label: string, detail?: string) {
      events.push({ at: Date.now(), label, detail });
      if (events.length > limit) events.splice(0, events.length - limit);
    },
    list(): MediaDiagnosticEvent[] {
      return events.slice();
    },
  };
}

export function describeMediaElement(video: HTMLVideoElement): MediaSnapshot {
  return {
    readyState: video.readyState,
    networkState: video.networkState,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    paused: video.paused,
    muted: video.muted,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    buffered: describeBuffered(video),
  };
}

function describeBuffered(video: HTMLVideoElement) {
  const { buffered } = video;
  if (!buffered || buffered.length === 0) return "空";
  const parts: string[] = [];
  for (let index = 0; index < buffered.length; index += 1) {
    parts.push(
      `${buffered.start(index).toFixed(1)}–${buffered.end(index).toFixed(1)}s`,
    );
  }
  return parts.join(", ");
}

export function describePipeline(
  hls: Hls | null,
  mode: MediaPipelineSnapshot["mode"],
  video: HTMLVideoElement,
  mediaSource: MediaSource | null,
): MediaPipelineSnapshot {
  let mediaSourceState = "未使用";
  if (mode !== "native") {
    // mpegts.js keeps its MediaSource private and does not expose an accessor, so the object is
    // never available here even though one is definitely mounted. Reporting "未挂载" for a working
    // FLV stream would contradict the buffered seconds shown beside it, so the row names the real
    // owner instead. The blob URL on the element is the corroborating evidence: mpegts.js only ever
    // plays through `URL.createObjectURL`, so its absence means the pipeline never attached.
    if (mode === "flv-mpegts") {
      mediaSourceState = video.src.startsWith("blob:")
        ? "由 mpegts.js 托管"
        : "未挂载";
    } else {
      mediaSourceState = mediaSource?.readyState ?? "未挂载";
    }
  }
  let bufferedSeconds = 0;
  const { buffered } = video;
  if (buffered && buffered.length > 0) {
    bufferedSeconds = Math.max(
      0,
      buffered.end(buffered.length - 1) - buffered.start(0),
    );
  }
  return {
    mode,
    levelCount: hls?.levels?.length ?? 0,
    currentLevel: hls?.currentLevel ?? -1,
    loadLevel: hls?.loadLevel ?? -1,
    mediaSourceState,
    bufferedSeconds,
  };
}

export const mediaStatusLabels: Record<MediaStatus, string> = {
  idle: "等待播放",
  loading: "正在连接",
  ready: "已准备",
  playing: "正在播放",
  paused: "已暂停",
  ended: "播放结束",
  error: "播放失败",
};

export const mediaPipelineLabels: Record<
  MediaPipelineSnapshot["mode"],
  string
> = {
  "hls-worker": "hls.js（转封装线程）",
  "hls-inline": "hls.js（主线程转封装）",
  "flv-mpegts": "mpegts.js（HTTP-FLV 转封装）",
  native: "原生 video",
};

/**
 * Renders one mpegts.js error for the diagnostic timeline.
 *
 * mpegts.js reports its failures as three separate arguments — a type, a detail and a message
 * object — and none of them is meaningful alone. A network failure and a codec failure both arrive
 * as `ERROR`, so the type is what tells the user whether to blame the upstream or the stream's
 * encoding; without it every FLV failure reads identically.
 */
export function describeMpegtsError(
  errorType?: string,
  errorDetail?: string,
  errorInfo?: { code?: number; msg?: string },
) {
  const parts: string[] = [];
  if (errorType) parts.push(errorType);
  if (errorDetail) parts.push(errorDetail);
  if (errorInfo?.code) parts.push(`code ${errorInfo.code}`);
  if (errorInfo?.msg) parts.push(errorInfo.msg);
  return parts.length > 0 ? parts.join(" · ") : "mpegts.js 未提供错误详情";
}

/**
 * Turns an mpegts.js error into the sentence the user reads.
 *
 * The FLV pipeline must not talk about an "HLS 清单" (manifest): the whole reason this pipeline
 * exists is that an FLV stream is not a playlist, and reporting a manifest problem for one would
 * describe a stage that never ran.
 */
export function formatMpegtsError(
  errorType?: string,
  errorDetail?: string,
  errorInfo?: { code?: number; msg?: string },
) {
  const detail = describeMpegtsError(errorType, errorDetail, errorInfo);
  const status = errorInfo?.code || extractUpstreamStatus(errorInfo?.msg);
  const statusNote = status ? `（HTTP ${status}）` : "";
  switch (errorDetail) {
    case "NetworkException":
    case "NetworkError":
      if (errorInfo?.msg && looksLikeTimeout(errorInfo.msg)) {
        return "连接 FLV 直播流超时，上游没有在限定时间内继续发送数据。该地址可能已失效或只对特定运营商网络开放。";
      }
      return `无法从上游持续读取 FLV 直播流${statusNote}。该地址可能已失效，或只对特定运营商网络开放。`;
    case "NetworkStatusCodeInvalid":
      return `上游拒绝了 FLV 直播流请求${statusNote}。这类地址通常只对特定运营商网络或授权客户端开放。`;
    case "NetworkUnrecoverableEarlyEof":
      return "FLV 直播流在播放中途被上游关闭，且无法重新连接。请切换频道或稍后重试。";
    case "MediaFormatError":
      return "FLV 直播流已返回，但封装格式无法解析；该地址可能并不是有效的 FLV 流。";
    case "MediaCodecUnsupported":
      return "FLV 直播流的编码当前播放环境无法解码（常见于 H.265 或非 AAC 音轨）。";
    case "MediaMSEError":
      return "FLV 直播流无法写入播放缓冲区，当前播放环境可能不支持该编码。";
    default:
      return `FLV 直播播放失败：${detail}`;
  }
}

/**
 * Renders one hls.js error for the diagnostic timeline. The Tauri loader reports its
 * own failures through the loader error text, which hls.js forwards on
 * `response.text`; without it every manifest failure looks identical even though
 * "connection closed", "HTTP 403" and "not an HLS playlist" are three different
 * problems with three different fixes.
 */
export function describeHlsError(data: ErrorData) {
  const parts: string[] = [data.type, data.details];
  const status = data.response?.code || extractUpstreamStatus(data.response?.text);
  if (status) {
    parts.push(`HTTP ${status}`);
  }
  const detail =
    data.response?.text ??
    (data.error instanceof Error ? data.error.message : undefined);
  if (detail) {
    parts.push(detail);
  }
  if (data.reason) {
    parts.push(data.reason);
  }
  return parts.join(" · ");
}

/**
 * Recovers an upstream HTTP status from a loader error message. The Tauri loader reports
 * its own failures with `code: 0`, so the status only survives inside the text, where
 * reqwest renders it as "HTTP status client error (403 Forbidden) for url (...)".
 * Without this, a 403 and a dead connection produce the same generic hint.
 */
export function extractUpstreamStatus(message?: string) {
  if (!message) return 0;
  const reqwestShape = message.match(/status\s+\w+\s+error\s+\((\d{3})\b/i);
  if (reqwestShape) return Number(reqwestShape[1]);
  const plainShape = message.match(/\bHTTP\s+(\d{3})\b/i);
  return plainShape ? Number(plainShape[1]) : 0;
}

export function formatHlsError(
  details?: string,
  statusCode?: number,
  responseText?: string,
) {
  const upstreamStatus = statusCode || extractUpstreamStatus(responseText);
  const status = upstreamStatus ? `（HTTP ${upstreamStatus}）` : "";
  switch (details) {
    case "manifestLoadError":
      if (upstreamStatus === 415) {
        return "当前频道返回了 HTTP 200，但正文不是有效的 HLS 清单，已跳过该线路。";
      }
      if (upstreamStatus === 401 || upstreamStatus === 403) {
        // A region block is a distinct and common cause, and it is the one the user can actually
        // act on — by changing which network or exit the request leaves from. The upstream names
        // it in the response body ("The region has been denied"), so the diagnosis does too,
        // rather than lumping it in with a generic refusal.
        if (looksLikeRegionDenial(responseText)) {
          return `上游按地区拒绝了访问${status}：该地址在当前网络出口所在地区不可用。换用其它源，或让请求从允许的地区发出即可播放。`;
        }
        return `上游拒绝访问当前频道${status}。这类地址通常只对特定运营商网络或授权客户端开放。`;
      }
      // Timeout before the connection markers: a timed-out request also reads as "connection
      // closed" in some stacks, and the deadline is the more accurate explanation.
      if (looksLikeTimeout(responseText)) {
        return "连接上游超时，对方没有在限定时间内返回直播清单。该地址可能只对特定运营商网络开放，或当前网络到该地址的链路不通。";
      }
      if (looksLikeConnectionFailure(responseText)) {
        return "无法与上游建立可用连接：对端在返回任何响应前就关闭了连接。该地址可能已失效，或只对特定运营商网络开放。";
      }
      return `当前频道的 HLS 清单请求失败${status}。频道目录可用，但上游播放地址可能已失效或拒绝访问。`;
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

/**
 * Whether the upstream closed the connection before answering.
 *
 * The markers must be specific. This list used to include `error sending request`, which is
 * reqwest's generic prefix on *every* transport failure — a timeout, a DNS failure and a closed
 * connection all start with it. So `…；operation timed out` was reported to the user as "对端在
 * 返回任何响应前就关闭了连接", blaming the peer for what was our own deadline. Only markers that
 * name the actual condition belong here.
 */
function looksLikeConnectionFailure(responseText?: string) {
  if (!responseText) return false;
  const text = responseText.toLowerCase();
  return [
    "connection closed",
    "connection reset",
    "connection refused",
    "unexpected eof",
    "broken pipe",
    "无法解析远程主机",
  ].some((marker) => text.includes(marker));
}

/** Whether the request ran out of time rather than being refused. */
function looksLikeTimeout(responseText?: string) {
  if (!responseText) return false;
  const text = responseText.toLowerCase();
  return [
    "operation timed out",
    "timed out",
    "timeout",
    "deadline has elapsed",
    "超时",
  ].some((marker) => text.includes(marker));
}

/**
 * Whether the upstream refused by region rather than by credential.
 *
 * Worth separating from a plain 401/403 because the two have different remedies and the upstream
 * states which one it is. Several Chinese CDNs answer a blocked region with an English body —
 * "The region has been denied", "Access denied by region", "not available in your country" — and
 * that is the whole explanation. Reporting it as "只对特定运营商网络开放" points the user at the
 * wrong thing: the address is not operator-restricted, it is refused for where the request came
 * from, so changing network or exit is what fixes it.
 */
function looksLikeRegionDenial(responseText?: string) {
  if (!responseText) return false;
  const text = responseText.toLowerCase();
  return [
    "region has been denied",
    "region denied",
    "denied by region",
    "region is not allowed",
    "not available in your",
    "not available in this",
    "geo-restricted",
    "geoblocked",
    "geo blocked",
    "地区限制",
    "区域限制",
    "当前地区",
    "不在服务范围",
  ].some((marker) => text.includes(marker));
}
