import { Clock3, Play, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MediaPoster } from "@/components/media-poster";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { useAppStore } from "@/stores/app-store";
import type { ViewKey } from "@/types/moseek";

interface HistoryViewProps {
  onNavigate: (view: ViewKey) => void;
}

export function HistoryView({ onNavigate }: HistoryViewProps) {
  const history = useAppStore((state) => state.history);
  const clearHistory = useAppStore((state) => state.clearHistory);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* 48px Header */}
      <header
        className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none"
      >
        <div className="flex items-center gap-2">
          <Clock3 className="size-4 text-primary" />
          <h1 className="text-sm font-semibold tracking-tight text-foreground">
            最近播放历史
          </h1>
          <span className="text-xs text-muted-foreground">
            ({history.length} 条记录)
          </span>
        </div>
        {history.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive gap-1.5"
            onClick={clearHistory}
          >
            <Trash2 className="size-3.5" />
            清空历史
          </Button>
        )}
      </header>

      {/* Main Content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4">
          {history.length === 0 ? (
            <div className="flex h-96 items-center justify-center">
              <Empty className="max-w-md border-border/40 bg-card/20 py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Clock3 className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle className="text-sm">暂无播放足迹</EmptyTitle>
                  <EmptyDescription className="text-xs">
                    在影视库点播任何选集，系统会自动在此记忆播放节点与线路。
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button type="button" size="sm" onClick={() => onNavigate("browse")}>
                    去影库看看
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 max-w-4xl mx-auto">
              {history.map((record) => (
                <div
                  key={record.id}
                  className="group flex items-center gap-3 rounded-md border border-border/60 bg-card/40 p-2 transition-all duration-150 hover:border-primary/40 hover:bg-card/80 cursor-pointer"
                  onClick={() => onNavigate("browse")}
                >
                  <MediaPoster
                    src={record.item.poster}
                    alt={`${record.item.name} 海报`}
                    className="h-12 w-20 shrink-0 rounded overflow-hidden"
                  />
                  <div className="min-w-0 flex-1 flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                        {record.item.name}
                      </p>
                      <span className="text-xs text-primary font-medium">
                        [{record.episodeName}]
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>源：{record.item.sourceName}</span>
                      <span>·</span>
                      <span>进度：{formatSeconds(record.progress)}</span>
                      <span>·</span>
                      <span>{formatHistoryDate(record.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground group-hover:text-primary pr-2">
                    <Play className="size-4 fill-current" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <ScrollBar />
      </ScrollArea>
    </div>
  );
}

function formatSeconds(seconds: number) {
  if (!seconds || seconds <= 0) return "刚开始看";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatHistoryDate(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return new Date(timestamp).toLocaleDateString();
}
