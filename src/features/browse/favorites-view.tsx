import { Bookmark, Heart } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { useAppStore } from "@/stores/app-store";
import type { ViewKey } from "@/types/moseek";

interface FavoritesViewProps {
  onNavigate: (view: ViewKey) => void;
}

export function FavoritesView({ onNavigate }: FavoritesViewProps) {
  const favorites = useAppStore((state) => state.favorites);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-8 py-8">
        <section>
          <p className="text-sm font-medium text-primary">我的片单</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
            收藏
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            把值得回看的内容留在一个安静的列表里。
          </p>
        </section>
        {favorites.length === 0 ? (
          <Empty className="min-h-96 border border-dashed bg-card/40">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Bookmark data-icon="inline-start" aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>还没有收藏内容</EmptyTitle>
              <EmptyDescription>
                在影视详情页点击收藏，内容会出现在这里。
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
                <Heart data-icon="inline-start" aria-hidden="true" />
                已收藏的影视
              </CardTitle>
              <CardDescription>{favorites.length} 部内容</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-4 gap-4">
              {favorites.map((item) => (
                <div
                  key={item.id}
                  className="group overflow-hidden rounded-md border bg-card"
                >
                  <div className="aspect-[2/3] overflow-hidden bg-muted">
                    <img
                      src={item.poster}
                      alt={`${item.name} 海报`}
                      className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {item.name}
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {item.sourceName}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`取消收藏 ${item.name}`}
                      onClick={() => toggleFavorite(item)}
                    >
                      <Heart data-icon="inline-start" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
      <ScrollBar />
    </ScrollArea>
  );
}
