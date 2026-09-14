import { ArrowUpRight, Clock3, History, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MediaPoster } from "@/components/media-poster";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useAppStore } from "@/stores/app-store";
import type { ViewKey } from "@/types/moseek";

interface HistoryViewProps {
  onNavigate: (view: ViewKey) => void;
}

export function HistoryView({ onNavigate }: HistoryViewProps) {
  const history = useAppStore((state) => state.history);
  const clearHistory = useAppStore((state) => state.clearHistory);

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-8 py-8">
        <section>
          <p className="text-sm font-medium text-primary">你的轨迹</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
            播放历史
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            最近选择的线路和选集会保存在本机。
          </p>
        </section>
        {history.length === 0 ? (
          <Empty className="min-h-96 border border-dashed bg-card/40">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History data-icon="inline-start" aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>还没有播放历史</EmptyTitle>
              <EmptyDescription>
                在影视库详情中选择一个选集，Moseek 会从这里记住你的进度入口。
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" onClick={() => onNavigate("browse")}>
                浏览影视库
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock3 data-icon="inline-start" aria-hidden="true" />
                最近播放
              </CardTitle>
              <CardDescription>
                共 {history.length} 条记录，最多保留 100 条。
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="px-6">
                {history.map((record) => (
                  <div key={record.id} className="flex items-center gap-4 py-4">
                    <MediaPoster
                      src={record.item.poster}
                      alt={`${record.item.name} 海报`}
                      className="h-20 w-36 shrink-0 rounded-md"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-medium">
                          {record.item.name}
                        </p>
                        <span className="text-xs text-muted-foreground">
                          {record.item.sourceName}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {record.episodeName} · 已记忆{" "}
                        {formatSeconds(record.progress)}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {formatHistoryDate(record.updatedAt)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => onNavigate("browse")}
                    >
                      继续查看
                      <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </div>
              <Separator />
              <div className="flex items-center justify-between px-6 py-3 text-xs text-muted-foreground">
                <span>进度会在播放器播放时自动更新。</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-muted-foreground"
                  onClick={clearHistory}
                >
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  清理历史
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      <ScrollBar />
    </ScrollArea>
  );
}

function formatHistoryDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatSeconds(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safeSeconds / 60)).padStart(2, "0")}:${String(safeSeconds % 60).padStart(2, "0")}`;
}
