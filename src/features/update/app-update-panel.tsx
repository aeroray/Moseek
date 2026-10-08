import { CircleAlert, Download, LoaderCircle, RefreshCw, RotateCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ReleaseNotes } from "@/features/update/release-notes-view";
import {
  canCheckForUpdates,
  useUpdateStore,
} from "@/features/update/update-store";

/**
 * 关于与更新 — the app-update module.
 *
 * Built around what the user is actually deciding: *which* version they would move to, and *what
 * changed*. The release notes are the whole reason to press 立即安装, so they are on screen rather
 * than behind a link.
 */
export function AppUpdatePanel({ currentVersion }: { currentVersion: string }) {
  const phase = useUpdateStore((state) => state.phase);
  const available = useUpdateStore((state) => state.available);
  const progress = useUpdateStore((state) => state.progress);
  const error = useUpdateStore((state) => state.error);
  const lastCheckedAt = useUpdateStore((state) => state.lastCheckedAt);
  const upToDate = useUpdateStore((state) => state.upToDate);
  const check = useUpdateStore((state) => state.check);
  const install = useUpdateStore((state) => state.install);

  const supported = canCheckForUpdates();
  const checking = phase === "checking";
  const downloading = phase === "downloading";
  const installing = phase === "installing";
  const busy = downloading || installing;

  return (
    /* `py-5` is this panel's own vertical padding. It is the one tab body that is not a stack of
       `SettingRow`s, and those carry `py-3.5` each — so without this the panel sat flush against the
       card's header hairline and its bottom edge, which is the cramped look that was reported. */
    <div className="flex flex-col gap-4 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              Moseek 拾影
            </span>
            <Badge variant="secondary" className="tabular-nums">
              v{currentVersion}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {!supported
              ? "浏览器预览不会检查更新，请在桌面应用中使用此功能。"
              : checking
                ? "正在检查更新…"
                : installing
                  ? "正在安装，完成后应用会自动重启…"
                  : downloading
                    ? "正在下载更新…"
                    : available
                      ? `发现新版本 v${available.version}`
                      : upToDate
                        ? "已是最新版本"
                        : "尚未检查更新"}
            {lastCheckedAt && supported && !checking ? (
              <span className="ml-1 text-muted-foreground/70">
                （上次检查：{formatCheckedAt(lastCheckedAt)}）
              </span>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!supported || checking || busy}
            onClick={() => void check()}
          >
            {checking ? (
              <LoaderCircle className="size-3.5 animate-spin" data-icon="inline-start" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-3.5" data-icon="inline-start" aria-hidden="true" />
            )}
            {checking ? "检查中…" : "检查更新"}
          </Button>
          {available ? (
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={!supported || busy}
              onClick={() => void install()}
            >
              <Download className="size-3.5" data-icon="inline-start" aria-hidden="true" />
              {downloading ? "下载中…" : installing ? "安装中…" : "立即安装"}
            </Button>
          ) : null}
        </div>
      </div>

      {downloading ? (
        <DownloadProgress percent={progress} />
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <p className="text-xs leading-5 text-destructive">{error}</p>
        </div>
      ) : null}

      {available?.notes?.trim() ? (
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <RotateCw className="size-3" aria-hidden="true" />
            更新内容
          </p>
          <ReleaseNotes markdown={available.notes} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A thin determinate bar. Indeterminate — the server sent no length — is a pulsing bar rather than a
 * fake percentage, because inventing motion for unknown progress would claim more than we know.
 */
function DownloadProgress({ percent }: { percent: number | null }) {
  if (percent === null) {
    return (
      <div
        role="progressbar"
        aria-label="正在下载更新，进度未知"
        className="h-1.5 w-full animate-pulse rounded-full bg-primary/40"
      />
    );
  }
  return (
    <div
      role="progressbar"
      aria-label="下载进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-300 ease-out",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function formatCheckedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
