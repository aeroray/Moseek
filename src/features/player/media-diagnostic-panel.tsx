import { useMemo, useState } from "react";
import { ClipboardCheck, ClipboardCopy, ScrollText } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  mediaPipelineLabels,
  mediaStatusLabels,
  type MediaDiagnosticSnapshot,
} from "@/features/player/media-diagnostics";
import { cn } from "@/lib/utils";

interface MediaDiagnosticPanelProps {
  snapshot: MediaDiagnosticSnapshot | null;
  note?: string | null;
  className?: string;
}

export function MediaDiagnosticPanel({
  snapshot,
  note,
  className,
}: MediaDiagnosticPanelProps) {
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");
  const report = useMemo(
    () => buildReportText(snapshot, note),
    [note, snapshot],
  );

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyState("done");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 2_000);
  };

  const copyButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!snapshot && !note}
      onClick={() => void copyReport()}
    >
      {copyState === "done" ? (
        <ClipboardCheck className="size-3.5" data-icon="inline-start" aria-hidden="true" />
      ) : (
        <ClipboardCopy className="size-3.5" data-icon="inline-start" aria-hidden="true" />
      )}
      {copyState === "done"
        ? "已复制"
        : copyState === "failed"
          ? "复制失败"
          : "复制诊断"}
    </Button>
  );

  const body = (
    <>
      {note && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
          {note}
        </p>
      )}

      {snapshot ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <DiagnosticRow
              label="播放状态"
              value={mediaStatusLabels[snapshot.status]}
            />
            <DiagnosticRow
              label="媒体管线"
              value={mediaPipelineLabels[snapshot.pipeline.mode]}
            />
            <DiagnosticRow
              label="媒体类型"
              value={`${snapshot.source.kind.toUpperCase()}${
                snapshot.source.isLive ? " · 直播" : ""
              }`}
            />
            <DiagnosticRow
              label="码率档位"
              value={`${snapshot.pipeline.levelCount} 档 · 当前 ${formatLevel(
                snapshot.pipeline.currentLevel,
              )} / 加载 ${formatLevel(snapshot.pipeline.loadLevel)}`}
            />
            <DiagnosticRow
              label="缓冲区"
              value={`${snapshot.pipeline.bufferedSeconds.toFixed(1)}s · MediaSource ${
                snapshot.pipeline.mediaSourceState
              }`}
            />
            <DiagnosticRow
              label="媒体元素"
              value={`readyState ${snapshot.media.readyState} · networkState ${
                snapshot.media.networkState
              } · ${snapshot.media.videoWidth}×${snapshot.media.videoHeight} · ${snapshot.media.currentTime.toFixed(1)}s${
                snapshot.media.paused ? " · 暂停" : " · 播放中"
              }`}
            />
            <DiagnosticRow
              label="转封装线程"
              value={
                snapshot.environment
                  ? snapshot.environment.transmuxWorkerSupported
                    ? "可用"
                    : `不可用（${snapshot.environment.transmuxWorkerNote}）`
                  : "检测中..."
              }
            />
            <DiagnosticRow
              label="解码支持"
              value={
                snapshot.environment
                  ? `H.264 ${yesNo(snapshot.environment.avcSupported)} · H.265 ${yesNo(
                      snapshot.environment.hevcSupported,
                    )} · AAC ${yesNo(snapshot.environment.aacSupported)}`
                  : "检测中..."
              }
            />
          </dl>

          <div>
            <p className="mb-1 text-xs text-muted-foreground">当前地址</p>
            <p className="break-all rounded-md border bg-muted/25 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
              {snapshot.source.url}
            </p>
          </div>

          {snapshot.environment && (
            <p
              className="truncate text-[11px] text-muted-foreground"
              title={snapshot.environment.userAgent}
            >
              运行环境：
              {snapshot.environment.tauriRuntime ? "Tauri 桌面端" : "浏览器预览"} ·
              MediaSource {yesNo(snapshot.environment.mediaSourceSupported)} ·
              hls.js {yesNo(snapshot.environment.hlsJsSupported)}
            </p>
          )}

          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              事件时间线（最新在上，共 {snapshot.events.length} 条）
            </p>
            <ScrollArea className="h-[200px] rounded-md border bg-muted/20">
              <div className="flex flex-col gap-1 p-3">
                {snapshot.events.length > 0 ? (
                  snapshot.events
                    .slice()
                    .reverse()
                    .map((event, index) => (
                      <p
                        key={`${event.at}-${index}`}
                        className="font-mono text-[11px] leading-5 break-all text-muted-foreground"
                      >
                        <span className="text-foreground/70">
                          {formatClock(event.at)}
                        </span>{" "}
                        <span className="text-foreground">{event.label}</span>
                        {event.detail ? ` · ${event.detail}` : ""}
                      </p>
                    ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    还没有播放事件。
                  </p>
                )}
              </div>
            </ScrollArea>
          </div>
        </>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs leading-5 text-muted-foreground">
          尚未开始播放，暂时没有诊断数据。
        </p>
      )}
    </>
  );

  return (
    /* `gap-0` overrides the Card's own `gap-4`. That gap sat between the header and the content
       on top of the header's `pb-3`, so the note box ended up ~28px below the description — far
       more separation than the note needs from the heading it belongs to. The header's own
       padding is now the only spacing between them. */
    <Card className={cn("gap-0", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
              播放诊断
            </CardTitle>
            <CardDescription>
              播放失败时复制这段内容，可直接定位到具体环节
            </CardDescription>
          </div>
          {copyButton}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{body}</CardContent>
    </Card>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium">{value}</dd>
    </div>
  );
}

function yesNo(value: boolean) {
  return value ? "支持" : "不支持";
}

function formatLevel(level: number) {
  return level < 0 ? "自动" : String(level);
}

function formatClock(at: number) {
  const date = new Date(at);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}.${pad(date.getMilliseconds(), 3)}`;
}

function buildReportText(
  snapshot: MediaDiagnosticSnapshot | null,
  note?: string | null,
) {
  const lines: string[] = ["Moseek 播放诊断"];
  if (note) lines.push(`前置提示：${note}`);
  if (!snapshot) {
    lines.push("（尚未开始播放，没有播放器数据）");
    return lines.join("\n");
  }
  lines.push(
    `播放状态：${mediaStatusLabels[snapshot.status]}`,
    `失败信息：${snapshot.message ?? "无"}`,
    `媒体管线：${mediaPipelineLabels[snapshot.pipeline.mode]}`,
    `媒体类型：${snapshot.source.kind}${snapshot.source.isLive ? "（直播）" : ""}`,
    `当前地址：${snapshot.source.url}`,
    `请求头：${JSON.stringify(snapshot.source.headers)}`,
    `码率档位：${snapshot.pipeline.levelCount}（当前 ${snapshot.pipeline.currentLevel} / 加载 ${snapshot.pipeline.loadLevel}）`,
    `缓冲区：${snapshot.pipeline.bufferedSeconds.toFixed(1)}s，MediaSource ${snapshot.pipeline.mediaSourceState}`,
    `媒体元素：readyState ${snapshot.media.readyState}，networkState ${snapshot.media.networkState}，${snapshot.media.videoWidth}×${snapshot.media.videoHeight}，位置 ${snapshot.media.currentTime.toFixed(1)}s，${snapshot.media.paused ? "暂停" : "播放中"}，muted ${snapshot.media.muted}，buffered ${snapshot.media.buffered}`,
  );
  if (snapshot.environment) {
    const environment = snapshot.environment;
    lines.push(
      `运行环境：${environment.tauriRuntime ? "Tauri" : "浏览器预览"}，MediaSource ${environment.mediaSourceSupported}，hls.js ${environment.hlsJsSupported}`,
      `转封装线程：${environment.transmuxWorkerSupported}（${environment.transmuxWorkerNote}）`,
      `解码支持：H.264 ${environment.avcSupported}，H.265 ${environment.hevcSupported}，AAC ${environment.aacSupported}`,
      `UserAgent：${environment.userAgent}`,
    );
  } else {
    lines.push("运行环境：检测中");
  }
  lines.push("事件时间线（最新在上）：");
  snapshot.events
    .slice()
    .reverse()
    .forEach((event) => {
      lines.push(
        `${formatClock(event.at)} ${event.label}${event.detail ? ` · ${event.detail}` : ""}`,
      );
    });
  return lines.join("\n");
}
