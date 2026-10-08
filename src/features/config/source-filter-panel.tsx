import type { ReactNode } from "react";
import { RotateCcw, SlidersHorizontal, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  clearedSourceFilter,
  enabledFacetLabels,
  executionFacetLabels,
  facetCounts,
  isFilterUnfiltered,
  statusFacetLabels,
  toggleFacet,
  type SourceEnabledFacet,
  type SourceExecutionFacet,
  type SourceFilterState,
  type SourceStatusFacet,
} from "@/features/config/source-filter";
import { adapterRegistry, type AdapterId } from "@/lib/adapters";
import { cn } from "@/lib/utils";
import type { SourceRecord } from "@/types/moseek";

/**
 * The toolbar's filter button.
 *
 * Split from the facets so it can sit in the toolbar row while the facets expand below it: a panel
 * nested inside the row would squeeze the search box instead of pushing the list down.
 */
export function SourceFilterTrigger({
  activeGroupCount,
  open,
  onOpenChange,
}: {
  activeGroupCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 gap-1.5"
      aria-expanded={open}
      aria-controls="source-filter-panel"
      onClick={() => onOpenChange(!open)}
    >
      {open ? (
        <X className="size-3.5" data-icon="inline-start" aria-hidden="true" />
      ) : (
        <SlidersHorizontal
          className="size-3.5"
          data-icon="inline-start"
          aria-hidden="true"
        />
      )}
      筛选
      {activeGroupCount > 0 && (
        <Badge
          variant="secondary"
          className="ml-0.5 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] tabular-nums"
        >
          {activeGroupCount}
        </Badge>
      )}
    </Button>
  );
}

/**
 * The filter's four groups.
 *
 * Inline under the toolbar rather than floating. A filter is something the user reads while deciding,
 * and a popover that closes on an outside click loses the panel mid-thought; it also drags a
 * positioning library into a component whose job is to render a dozen checkboxes.
 *
 * Within a group the choices are OR-ed; across groups they are AND-ed. The count beside each choice
 * is what that choice would leave given the *other* groups, so ticking one box does not zero out its
 * siblings and the panel stays usable for exploring.
 */
export function SourceFilterFacets({
  sources,
  value,
  onChange,
}: {
  sources: SourceRecord[];
  value: SourceFilterState;
  onChange: (next: SourceFilterState) => void;
}) {
  const counts = facetCounts(sources, value);
  const unfiltered = isFilterUnfiltered(value);

  // Every adapter the current list actually contains, most-used first, so the ones a user is likely
  // to want are not buried. An adapter with no sources is not offered: a choice that can only ever
  // return nothing is not a choice.
  const adapterIds = [...counts.adapters.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] || adapterLabel(a[0]).localeCompare(adapterLabel(b[0]), "zh"),
    )
    .map(([id]) => id);

  const executionOrder: SourceExecutionFacet[] = ["enabled", "needs-adapter"];
  // No "blocked" entry: a source with no runnable adapter has no test outcome, and the 适配器状态
  // group offers exactly that set. See `sourceStatusFacet`.
  const statusOrder: SourceStatusFacet[] = [
    "usable",
    "untested",
    "failed",
    "empty",
    "invalid",
  ];
  const enabledOrder: SourceEnabledFacet[] = ["on", "off"];

  return (
    <section
      id="source-filter-panel"
      aria-label="筛选条件"
      className="rounded-lg border border-border/70 bg-card/60 p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          同一组内满足任一条件，组与组之间需同时满足。
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
          // Clears every group, which is what "reset" has to mean: the page's opening view is
          // itself filtered, so resetting to it would leave the whole list unreachable.
          // Disabled rather than hidden: a reset that vanished when there was nothing to reset
          // would move the row around as the user ticks the first box.
          disabled={unfiltered}
          onClick={() => onChange(clearedSourceFilter)}
        >
          <RotateCcw className="size-3" aria-hidden="true" />
          重置
        </Button>
      </div>

      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <FacetGroup title="适配器">
          {adapterIds.map((id) => (
            <FacetRow
              key={id}
              label={adapterLabel(id)}
              count={counts.adapters.get(id) ?? 0}
              checked={value.adapters.includes(id)}
              onToggle={() =>
                onChange({
                  ...value,
                  adapters: toggleFacet(value.adapters, id),
                })
              }
            />
          ))}
          {adapterIds.length === 0 && <FacetEmpty />}
        </FacetGroup>

        <FacetGroup title="适配器状态">
          {executionOrder.map((facet) => (
            <FacetRow
              key={facet}
              label={executionFacetLabels[facet]}
              count={counts.executions.get(facet) ?? 0}
              checked={value.executions.includes(facet)}
              onToggle={() =>
                onChange({
                  ...value,
                  executions: toggleFacet(value.executions, facet),
                })
              }
            />
          ))}
        </FacetGroup>

        <FacetGroup title="测试状态">
          {statusOrder.map((facet) => (
            <FacetRow
              key={facet}
              label={statusFacetLabels[facet]}
              count={counts.statuses.get(facet) ?? 0}
              checked={value.statuses.includes(facet)}
              onToggle={() =>
                onChange({
                  ...value,
                  statuses: toggleFacet(value.statuses, facet),
                })
              }
            />
          ))}
        </FacetGroup>

        <FacetGroup title="启用">
          {enabledOrder.map((facet) => (
            <FacetRow
              key={facet}
              label={enabledFacetLabels[facet]}
              count={counts.enabled.get(facet) ?? 0}
              checked={value.enabled.includes(facet)}
              onToggle={() =>
                onChange({
                  ...value,
                  enabled: toggleFacet(value.enabled, facet),
                })
              }
            />
          ))}
        </FacetGroup>
      </div>
    </section>
  );
}

/**
 * The adapter's own name, which is what the 适配器 column shows.
 *
 * Read from the registry, which is keyed by id and does not depend on a source. Falling back to the
 * id keeps an adapter visible rather than dropping it from the panel.
 */
function adapterLabel(id: AdapterId): string {
  return adapterRegistry.find((profile) => profile.id === id)?.label ?? id;
}

/** One named group of choices. */
function FacetGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="px-2 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground/70">
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * One choice, with how many sources it would leave.
 *
 * The whole row is the control, so the label is a click target too — a checkbox alone makes the user
 * aim at a 16px box.
 *
 * The row is the **only** handler, and the checkbox carries none. Measured
 * (`propagation.test.tsx`): giving the box its own `onCheckedChange` as well makes a click fire
 * twice — once from the box and once from the bubbled click. The visible state still lands correctly
 * here because the update is computed from the state captured in the closure, so both calls produce
 * the same next value, but it is two renders for one click. With the row alone, a pointer click on
 * the box and a keyboard activation each fire exactly once, because a `<button>` turns Space into a
 * click that bubbles.
 *
 * The box is left to receive pointer events rather than given `pointer-events-none`. It has no
 * handler to double-fire, and letting its click bubble is what makes it work; a guard there would be
 * defensive code whose absence changes nothing observable.
 *
 * The row is a plain `div` rather than a `<label>`: `<button>` is a labelable element, so a label
 * would forward its click to the control as well and the choice would toggle twice.
 *
 * A choice that would leave nothing is disabled rather than hidden, so the panel keeps its shape
 * while the user reads it.
 */
function FacetRow({
  label,
  count,
  checked,
  onToggle,
}: {
  label: string;
  count: number;
  checked: boolean;
  onToggle: () => void;
}) {
  const empty = count === 0 && !checked;
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-1 text-sm transition-colors",
        empty ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-accent/60",
      )}
      onClick={empty ? undefined : onToggle}
    >
      <Checkbox checked={checked} disabled={empty} aria-label={label} />
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function FacetEmpty() {
  return (
    <p className="px-2 py-1 text-xs text-muted-foreground">
      当前配置没有可筛选的适配器。
    </p>
  );
}
