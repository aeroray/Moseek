import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import type { ViewKey } from "@/types/moseek";

interface PlaceholderViewProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel: string;
  onAction: (view: ViewKey) => void;
  actionView: ViewKey;
}

export function PlaceholderView({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  actionView,
}: PlaceholderViewProps) {
  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-8 py-12">
        <Empty className="max-w-lg border border-dashed bg-card/40 py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon className="size-5 text-primary" data-icon="inline-start" aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={() => onAction(actionView)}>
              {actionLabel}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
      <ScrollBar />
    </ScrollArea>
  );
}
