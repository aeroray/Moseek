import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** One clearable group: what it is called, how many there are, and the key the caller clears. */
export interface ClearTarget<K extends string = string> {
  kind: K;
  label: string;
  count: number;
}

/**
 * The confirm button's word, naming exactly what it is about to remove.
 *
 * A fixed "全部清空" sitting beside a deselected checkbox would contradict the control above it, so
 * the action states its own scope and the button and the checkboxes can never disagree. One kind
 * selected is named rather than summarised as 全部: with only films recorded, "清空全部" is true but
 * says less than "清空影视足迹", and the point of the label is to answer "what am I about to lose".
 */
export function clearActionText(clearedLabels: string[]) {
  if (clearedLabels.length === 0) return "清空";
  if (clearedLabels.length === 1) return `清空${clearedLabels[0]}`;
  return "清空全部";
}

/**
 * The confirmation dialog shared by 足迹, 我的收藏 and 系统设置.
 *
 * Clearing is a choice of *what* to clear, so the groups are checkboxes that start selected rather
 * than buttons that fire on click. The first version of the footprint dialog offered each kind as a
 * button and ran the clear the instant it was pressed, which read as "choose what you want to
 * remove" and behaved as "remove this now" — a user who meant to deselect 影视足迹 wiped it by
 * trying to select it. Defaulting everything on also keeps the common case (clear the lot) at one
 * click, and makes a partial clear an explicit deselection rather than a blind pick.
 *
 * Shared rather than copied per page: three callers now open this dialog, and three copies of a
 * destructive confirmation is three places for the wording and the default selection to drift.
 */
export function ClearRecordsDialog<K extends string>({
  open,
  onOpenChange,
  title,
  description,
  targets,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  targets: ClearTarget<K>[];
  onConfirm: (kinds: K[]) => void;
}) {
  const [selected, setSelected] = useState<K[]>([]);

  const selectable = targets.filter((target) => target.count > 0);
  // A string key rather than the array itself: `map` produces a new array on every render, so
  // depending on it directly would reset the selection continuously.
  const selectableKey = selectable.map((target) => target.kind).join("\u0000");

  useEffect(() => {
    if (!open) return;
    // Reopening starts fresh, and the reset is tied to `open` rather than to the open handler so it
    // also covers a caller that sets `open` directly. Leaving a previous deselection in place would
    // make the next visit clear less than the dialog appears to promise.
    setSelected(selectableKey ? (selectableKey.split("\u0000") as K[]) : []);
  }, [open, selectableKey]);

  const cleared = targets.filter(
    (target) => target.count > 0 && selected.includes(target.kind),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {targets.map((target) => {
            const isSelectable = target.count > 0;
            // A group with nothing in it is shown unchecked as well as unavailable: a disabled
            // checkbox that appears ticked would claim it is about to clear something.
            const checked = isSelectable && selected.includes(target.kind);
            return (
              <label
                key={target.kind}
                className={cn(
                  "flex items-center gap-3 rounded-md border border-transparent px-3 py-2.5 transition-colors",
                  isSelectable
                    ? "cursor-pointer hover:bg-muted/50"
                    : "cursor-not-allowed opacity-50",
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={!isSelectable}
                  onCheckedChange={(value) =>
                    setSelected((current) =>
                      value === true
                        ? [...new Set([...current, target.kind])]
                        : current.filter((item) => item !== target.kind),
                    )
                  }
                  aria-label={target.label}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-foreground">{target.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {isSelectable ? `${target.count} 条记录` : "没有可清空的记录"}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            // Nothing that would actually be cleared means there is nothing to do, so the action is
            // unavailable rather than silently doing nothing when pressed.
            disabled={cleared.length === 0}
            onClick={() => onConfirm(cleared.map((target) => target.kind))}
          >
            {clearActionText(cleared.map((target) => target.label))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
