import { getAdapterProfile, isTestableSource, type AdapterId } from "@/lib/adapters";
import type { SourceRecord, SourceTestStatus } from "@/types/moseek";

/**
 * The facets the source list can be narrowed by.
 *
 * Four independent groups, because they answer four different questions a user actually asks: which
 * adapter handles this, can that adapter run at all, how did the last test go, and is the source
 * switched on. Within a group the choices are alternatives (any of the selected matches); across
 * groups they are requirements (all groups must match). That is the usual reading of a filter panel,
 * and it is what makes "内置 CMS **or** XBPQ, that **failed**, and is **enabled**" expressible.
 */
export type SourceFilterState = {
  /** Adapter identities. Empty means "any adapter". */
  adapters: AdapterId[];
  /** Whether the adapter can run. Empty means "any". */
  executions: SourceExecutionFacet[];
  /** How the last test went. Empty means "any". */
  statuses: SourceStatusFacet[];
  /** Whether the source is switched on. Empty means "any". */
  enabled: SourceEnabledFacet[];
};

export type SourceExecutionFacet = "enabled" | "needs-adapter" | "blocked";
export type SourceEnabledFacet = "on" | "off";
export type SourceStatusFacet =
  | "usable"
  | "untested"
  | "failed"
  | "empty"
  | "blocked"
  | "invalid";

/**
 * What the page opens with.
 *
 * `executions: ["enabled"]` keeps the list on the sources that can actually run. Measured on the
 * author's configuration, 240 of 355 sources have no runnable adapter, so opening on all of them
 * would be a wall of rows the user cannot act on. It is a filter like any other, visible in the
 * panel and clearable, rather than a hidden rule.
 */
export const defaultSourceFilter: SourceFilterState = {
  adapters: [],
  executions: ["enabled"],
  statuses: [],
  enabled: [],
};

/**
 * Every group cleared, which shows every source.
 *
 * This is what 重置 produces, and it is deliberately **not** the same as `defaultSourceFilter`: a
 * reset has to be able to reach a state the page does not open in, or "reset" would mean "go back to
 * the opening view" and the whole list would be unreachable without hunting for which box is ticked.
 * Keeping them distinct is also what makes the reset button's enabled state honest.
 */
export const clearedSourceFilter: SourceFilterState = {
  adapters: [],
  executions: [],
  statuses: [],
  enabled: [],
};

/** Whether the filter is showing everything, so the UI can say so and offer a reset. */
export function isFilterUnfiltered(state: SourceFilterState): boolean {
  return (
    state.adapters.length === 0 &&
    state.executions.length === 0 &&
    state.statuses.length === 0 &&
    state.enabled.length === 0
  );
}

/** How many groups are narrowing the list, for the trigger's badge. */
export function activeFilterGroupCount(state: SourceFilterState): number {
  return [state.adapters, state.executions, state.statuses, state.enabled].filter(
    (group) => group.length > 0,
  ).length;
}

/**
 * The status facet a source belongs to.
 *
 * Derived from the same two facts the 状态 column renders — whether an adapter can run, and what the
 * last test said — so the facet a user picks matches the word they can see on the row.
 */
export function sourceStatusFacet(source: SourceRecord): SourceStatusFacet {
  if (!isTestableSource(source)) {
    // Without a runnable adapter there is no test outcome to report; the row shows the capability.
    return source.capability === "invalid" ? "invalid" : "blocked";
  }
  const status: SourceTestStatus = source.testStatus ?? "untested";
  switch (status) {
    case "passed":
      return "usable";
    case "empty":
      return "empty";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "untested":
    default:
      return "untested";
  }
}

/** Whether a source satisfies every group of the filter. */
export function matchesSourceFilterState(
  source: SourceRecord,
  state: SourceFilterState,
): boolean {
  if (
    state.adapters.length > 0 &&
    !state.adapters.includes(getAdapterProfile(source).id)
  ) {
    return false;
  }
  if (
    state.executions.length > 0 &&
    !state.executions.includes(getAdapterProfile(source).execution)
  ) {
    return false;
  }
  if (
    state.statuses.length > 0 &&
    !state.statuses.includes(sourceStatusFacet(source))
  ) {
    return false;
  }
  if (state.enabled.length > 0) {
    const facet: SourceEnabledFacet = source.enabled ? "on" : "off";
    if (!state.enabled.includes(facet)) return false;
  }
  return true;
}

/** Adds or removes one choice within a group. */
export function toggleFacet<T extends string>(group: T[], value: T): T[] {
  return group.includes(value) ? group.filter((item) => item !== value) : [...group, value];
}

/** The words each facet is offered under, in the order the panel lists them. */
export const executionFacetLabels: Record<SourceExecutionFacet, string> = {
  enabled: "可执行",
  "needs-adapter": "待适配",
  blocked: "已阻止",
};

export const statusFacetLabels: Record<SourceStatusFacet, string> = {
  usable: "可用",
  untested: "待测试",
  failed: "测试失败",
  empty: "无内容",
  blocked: "未执行",
  invalid: "配置无效",
};

export const enabledFacetLabels: Record<SourceEnabledFacet, string> = {
  on: "已启用",
  off: "已停用",
};

/**
 * How many sources each choice would leave, given the other groups.
 *
 * Counted with the choice's own group excluded, which is what makes the numbers useful: a count that
 * collapsed to zero as soon as a sibling was ticked would make the panel unusable for exploring.
 * A choice that would leave nothing is shown as 0 and disabled rather than hidden, so the panel does
 * not reflow under the pointer while the user is reading it.
 */
export function facetCounts(
  sources: SourceRecord[],
  state: SourceFilterState,
): {
  adapters: Map<AdapterId, number>;
  executions: Map<SourceExecutionFacet, number>;
  statuses: Map<SourceStatusFacet, number>;
  enabled: Map<SourceEnabledFacet, number>;
} {
  const adapters = new Map<AdapterId, number>();
  const executions = new Map<SourceExecutionFacet, number>();
  const statuses = new Map<SourceStatusFacet, number>();
  const enabled = new Map<SourceEnabledFacet, number>();

  const without = (group: keyof SourceFilterState): SourceFilterState => ({
    ...state,
    [group]: [],
  });

  const adaptersScope = sources.filter((source) =>
    matchesSourceFilterState(source, without("adapters")),
  );
  const executionsScope = sources.filter((source) =>
    matchesSourceFilterState(source, without("executions")),
  );
  const statusesScope = sources.filter((source) =>
    matchesSourceFilterState(source, without("statuses")),
  );
  const enabledScope = sources.filter((source) =>
    matchesSourceFilterState(source, without("enabled")),
  );

  for (const source of adaptersScope) {
    const id = getAdapterProfile(source).id;
    adapters.set(id, (adapters.get(id) ?? 0) + 1);
  }
  for (const source of executionsScope) {
    const facet = getAdapterProfile(source).execution;
    executions.set(facet, (executions.get(facet) ?? 0) + 1);
  }
  for (const source of statusesScope) {
    const facet = sourceStatusFacet(source);
    statuses.set(facet, (statuses.get(facet) ?? 0) + 1);
  }
  for (const source of enabledScope) {
    const facet: SourceEnabledFacet = source.enabled ? "on" : "off";
    enabled.set(facet, (enabled.get(facet) ?? 0) + 1);
  }

  return { adapters, executions, statuses, enabled };
}
