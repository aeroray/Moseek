import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A search field with a leading icon and a clear button.
 *
 * Extracted because the same field was written out four times — the source list, the adapter tab,
 * the visual editor and the raw-config editor — and they had drifted: two had no way to clear the
 * query at all, and the ones that had a leading icon each positioned it by hand. Four copies is four
 * places for the next change to miss one, which is exactly what happened.
 *
 * **The clear button is not a convenience.** Without it, undoing a search means selecting the text and
 * deleting it by hand, and the field keeps a filter applied that the user cannot see the end of; the
 * button appears only when there is something to clear, so its presence is itself the signal.
 *
 * **The padding is stated here rather than at each call site, and that is a fix as well as tidying.**
 * The field's height is fixed (`h-8` at `size="sm"`) and its text is `text-xs`, so the browser
 * centres the inner text box in the remaining space — which it does by baseline, leaving the glyphs a
 * pixel or two low. `leading-none` plus `py-0` removes the extra line box that made the text sit off
 * centre: with a fixed height, padding and a line height larger than the glyphs, the space is
 * distributed unevenly rather than centred.
 */
export function SearchInput({
  value,
  onValueChange,
  placeholder,
  "aria-label": ariaLabel,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  "aria-label": string;
  className?: string;
}) {
  return (
    <div className={cn("relative min-w-0 flex-1", className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
        aria-hidden="true"
      />
      <Input
        size="sm"
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        // `pl-8` clears the icon, `pr-8` clears the button. `[&::-webkit-search-cancel-button]:hidden`
        // drops WebKit's own clear affordance, which would otherwise appear beside ours on Windows.
        className="pl-8 pr-8 py-0 leading-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // `aria-label` rather than a tooltip alone: the button is an icon, so this is its name.
          aria-label="清除搜索"
          title="清除搜索"
          className="absolute right-1 top-1/2 size-6 -translate-y-1/2 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => onValueChange("")}
        >
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
