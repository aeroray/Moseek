import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * The empty state for a whole collection page — 我的收藏 and 足迹.
 *
 * Shared rather than written twice, because the two pages had drifted into centring against
 * different boxes: 我的收藏 wrapped `Empty` in `flex h-full items-center justify-center p-8`, while
 * 足迹 used `flex h-96 items-center justify-center`. Measured in a real browser with an empty store,
 * the empty box landed **52px** from the top of the content area on one page and **97px** on the
 * other — the same component, the same message, at two different heights. That is what the user
 * reported as "the position is not consistent".
 *
 * Neither wrapper was the right shape:
 *
 *  - `h-full` only resolves against a parent with a *definite* height. Here the parent is a block
 *    inside the scroll viewport's content, whose height is auto, so `h-full` collapsed to the
 *    content box and the `p-8` padding ended up deciding where things sat (52px ≈ that padding).
 *  - `h-96` is a fixed 384px, a number with nothing to do with the viewport it sits in — it just
 *    happened to land lower (97px).
 *
 * A fixed `min-h-80` is what this settles on, and it is deliberately the same shape 影视库 already
 * uses for its own empty state (`<Empty className="min-h-64 …">`): a definite height that does not
 * depend on resolving a percentage through Radix's internal viewport wrapper, so both pages put the
 * box at exactly the same place. The box grows if the description ever wraps past it, which is why
 * it is a *min* height rather than a fixed one.
 */
export function CollectionEmpty({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center justify-center">
      <Empty className="min-h-80 max-w-md border-border/40 bg-card/20 py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle className="text-sm">{title}</EmptyTitle>
          <EmptyDescription className="text-xs">{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
