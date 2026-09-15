import { Bookmark, Heart, Play, Trash2 } from "lucide-react";

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

interface FavoritesViewProps {
  onNavigate: (view: ViewKey) => void;
}

export function FavoritesView({ onNavigate }: FavoritesViewProps) {
  const favorites = useAppStore((state) => state.favorites);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* 48px Header */}
      <header
        className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-card/40 px-4 backdrop-blur-md select-none"
      >
        <div className="flex items-center gap-2">
          <Heart className="size-4 text-primary fill-primary" />
          <h1 className="text-sm font-semibold tracking-tight text-foreground">
            我的收藏片单
          </h1>
          <span className="text-xs text-muted-foreground">
            ({favorites.length} 部影视)
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onNavigate("browse")}
        >
          继续探索
        </Button>
      </header>

      {/* Main Content */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {favorites.length === 0 ? (
            <div className="flex h-96 items-center justify-center">
              <Empty className="max-w-md border-border/40 bg-card/20 py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Bookmark className="size-4 text-primary" data-icon="inline-start" aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle className="text-sm">收藏夹空空如也</EmptyTitle>
                  <EmptyDescription className="text-xs">
                    在影视库浏览时点击心形图标，心仪的影片就会汇聚在这里。
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button type="button" size="sm" onClick={() => onNavigate("browse")}>
                    浏览影视库
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
              {favorites.map((item) => (
                <div
                  key={item.id}
                  className="group relative flex flex-col overflow-hidden rounded-md border border-border/60 bg-card/60 transition-all duration-200 hover:-translate-y-1 hover:border-primary/50 hover:shadow-[0_4px_16px_rgba(0,0,0,0.4)] cursor-pointer"
                  onClick={() => onNavigate("browse")}
                >
                  <div className="relative aspect-[2/3] w-full overflow-hidden bg-muted/40">
                    <MediaPoster
                      src={item.poster}
                      alt={`${item.name} 海报`}
                      className="size-full"
                      imageClassName="transition-transform duration-300 group-hover:scale-105"
                    />
                    <div className="absolute top-1.5 right-1.5 z-10">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(item);
                        }}
                        className="rounded-full bg-black/60 p-1 text-primary backdrop-blur-xs transition-transform hover:scale-110 active:scale-95"
                        title="取消收藏"
                      >
                        <Heart className="size-3 fill-current" />
                      </button>
                    </div>
                  </div>
                  <div className="p-2.5 flex flex-col gap-1">
                    <p className="truncate text-xs font-semibold text-foreground group-hover:text-primary transition-colors">
                      {item.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.sourceName}
                    </p>
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
