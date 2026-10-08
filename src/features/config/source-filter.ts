import {
  adapterStatusLabel,
  getAdapterProfile,
  isTestableSource,
  type AdapterExecution,
  type AdapterId,
} from "@/lib/adapters";
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

/**
 * The execution group's choices.
 *
 * An alias rather than a second union: it was written out as `"enabled" | "needs-adapter" |
 * "blocked"` here while `AdapterExecution` in the adapter registry said exactly the same thing, so a
 * new execution state could be added to one and silently missing from the other. The registry owns
 * the vocabulary; the filter reuses it.
 *
 * There are now two choices rather than three. `blocked` was dropped along with the adapters that
 * carried it: the sources it described are removed from the configuration at import, so a choice
 * filtering to them could only ever return nothing.
 */
export type SourceExecutionFacet = AdapterExecution;
export type SourceEnabledFacet = "on" | "off";
/**
 * The test-status group's choices.
 *
 * No `blocked` member: that set is the 适配器状态 group's, exactly. See `sourceStatusFacet`.
 *
 * `invalid` stays. It is not covered by any execution choice — measured, the one invalid record in
 * the author's configuration has a runnable adapter (`execution: enabled`), so it is refused for a
 * reason the execution group cannot express. Dropping the choice would leave a row reading 配置无效
 * with no way to filter to it.
 */
export type SourceStatusFacet =
  | Exclude<SourceTestStatus, "passed" | "blocked">
  | "usable"
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
 * The status facet a source belongs to, or null when it has no test outcome.
 *
 * Derived from the same fact the 状态 column renders, so the facet a user picks matches the word they
 * can see on the row.
 *
 * **A source with no runnable adapter returns null rather than a facet.** Its 状态 column shows the
 * adapter's verdict — 已阻止 or 无法适配 — and that set is exactly what the 适配器状态 group offers:
 * measured, `execution: blocked` (226) plus `execution: needs-adapter` (13) is precisely the 239
 * sources this used to select as one facet. Offering the same 239 rows under two headings meant two
 * choices that both read 已阻止 while selecting different sets. The 测试状态 group is about test
 * outcomes, and a source that cannot be tested has none.
 */
export function sourceStatusFacet(source: SourceRecord): SourceStatusFacet | null {
  if (!isTestableSource(source)) {
    // The one case the execution group cannot express: a record the parser could not build still has
    // a runnable adapter, so no execution choice reaches it. Everything else untestable is already
    // selected by 已阻止 or 无法适配.
    return source.capability === "invalid" ? "invalid" : null;
  }
  const status: SourceTestStatus = source.testStatus ?? "untested";
  // The facet vocabulary is the test vocabulary with one rename: a passing test reads 可用 on the
  // row, and `usable` is what the panel offers for it. This was a five-case switch whose four other
  // arms each returned their own input, so it restated the type instead of mapping it.
  if (status === "passed") return "usable";
  // `blocked` cannot arrive here: the backend returns it when the adapter refuses to run, and
  // `isTestableSource` has already answered false for exactly those sources. Returning null rather
  // than inventing a facet keeps the group about test outcomes, and the compiler still sees every
  // arm.
  if (status === "blocked") return null;
  return status;
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
  if (state.statuses.length > 0) {
    // A source with no test outcome matches no status choice. It is reachable through the 适配器状态
    // group instead, which is where its 状态 column's word is offered.
    const facet = sourceStatusFacet(source);
    if (facet === null || !state.statuses.includes(facet)) return false;
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

/**
 * The words the execution group is offered under.
 *
 * Reuses `adapterStatusLabel` rather than repeating its three words. They were written out twice, so
 * the panel's 待适配 and the adapter column's could drift apart while both claimed to describe the
 * same source — and one of them was different again in `capability-badge.tsx`.
 */
export const executionFacetLabels: Record<SourceExecutionFacet, string> = {
  enabled: adapterStatusLabel("enabled"),
  "needs-adapter": adapterStatusLabel("needs-adapter"),
};

/**
 * The words each facet is offered under, in the order the panel lists them.
 *
 * **Every word here must be one a row actually shows**, because the choice is how a user finds those
 * rows: they read 已阻止 on a row, then look for it in the panel. Measured against the author's
 * configuration, `blocked` was offered as 未执行 while all 239 rows it reveals read 已阻止 (226) or
 * 无法适配 (13) — a label matching nothing on screen. It is now 已阻止, the word 226 of them carry;
 * the 13 无法适配 are a different condition and are offered by the 适配器状态 group instead.
 */
export const statusFacetLabels: Record<SourceStatusFacet, string> = {
  usable: "可用",
  untested: "待测试",
  failed: "测试失败",
  empty: "无内容",
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
    // Null means no test outcome, so no status choice would reveal this source and none should
    // claim it in its count.
    if (facet === null) continue;
    statuses.set(facet, (statuses.get(facet) ?? 0) + 1);
  }
  for (const source of enabledScope) {
    const facet: SourceEnabledFacet = source.enabled ? "on" : "off";
    enabled.set(facet, (enabled.get(facet) ?? 0) + 1);
  }

  return { adapters, executions, statuses, enabled };
}
