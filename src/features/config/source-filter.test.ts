import { describe, expect, it } from "vitest";

import {
  activeFilterGroupCount,
  defaultSourceFilter,
  enabledFacetLabels,
  executionFacetLabels,
  facetCounts,
  isFilterUnfiltered,
  matchesSourceFilterState,
  sourceStatusFacet,
  statusFacetLabels,
  toggleFacet,
  type SourceFilterState,
} from "@/features/config/source-filter";
import { adapterStatusLabel } from "@/lib/adapters";
import type { SourceRecord } from "@/types/moseek";

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    key: "demo",
    name: "示例源",
    sourceType: "cms",
    api: "https://example.com/api.php/provide/vod/",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "普通 HTTP API。",
    testStatus: "untested",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
    ...overrides,
  };
}

/** An empty filter, so a test names only the group it is exercising. */
function filter(overrides: Partial<SourceFilterState> = {}): SourceFilterState {
  return {
    adapters: [],
    executions: [],
    statuses: [],
    enabled: [],
    ...overrides,
  };
}

describe("the source filter's groups", () => {
  it("opens on the sources that can run, not on everything", () => {
    // Measured on the author's configuration: 240 of 355 sources have no runnable adapter. Opening
    // on all of them is a wall of rows the user cannot act on.
    expect(defaultSourceFilter.executions).toEqual(["enabled"]);
    expect(defaultSourceFilter.adapters).toEqual([]);
    expect(defaultSourceFilter.statuses).toEqual([]);
    expect(defaultSourceFilter.enabled).toEqual([]);
  });

  it("matches every group, and any choice within one", () => {
    const xbpq = source({ key: "a", api: "csp_XBPQ", siteProtocol: "xbpq", testStatus: "passed" });
    const cms = source({ key: "b", testStatus: "passed" });

    // Within a group, any of the chosen values matches. Asserted per group, because a group that is
    // silently ignored still returns the right answer whenever the fixture happens to agree — which
    // is how an AND-ed group went unnoticed.
    expect(matchesSourceFilterState(xbpq, filter({ adapters: ["xbpq", "builtin-cms"] }))).toBe(true);
    expect(matchesSourceFilterState(cms, filter({ adapters: ["xbpq", "builtin-cms"] }))).toBe(true);
    // A group the source does not satisfy excludes it.
    expect(matchesSourceFilterState(xbpq, filter({ adapters: ["builtin-cms"] }))).toBe(false);

    // Every group is required, so each one alone has to be able to exclude.
    const matching = filter({
      adapters: ["xbpq"],
      executions: ["enabled"],
      statuses: ["usable"],
      enabled: ["on"],
    });
    expect(matchesSourceFilterState(xbpq, matching)).toBe(true);
    for (const group of ["adapters", "executions", "statuses", "enabled"] as const) {
      const wrong = {
        ...matching,
        [group]:
          group === "adapters"
            ? ["builtin-cms"]
            : group === "executions"
              ? ["blocked"]
              : group === "statuses"
                ? ["failed"]
                : ["off"],
      } as SourceFilterState;
      expect(
        matchesSourceFilterState(xbpq, wrong),
        `${group} must be able to exclude on its own`,
      ).toBe(false);
    }

    // Two choices in one group are still an OR, so a source matching either is kept.
    const eitherStatus = filter({ statuses: ["failed", "usable"] });
    expect(matchesSourceFilterState(xbpq, eitherStatus)).toBe(true);
    const eitherAdapter = filter({ adapters: ["builtin-cms", "xbpq"] });
    expect(matchesSourceFilterState(xbpq, eitherAdapter)).toBe(true);
  });

  it("reads the status facet from the same facts the row shows", () => {
    // The facet a user picks has to match the word they can see in the 状态 column.
    expect(sourceStatusFacet(source({ testStatus: "passed" }))).toBe("usable");
    expect(sourceStatusFacet(source({ testStatus: "untested" }))).toBe("untested");
    expect(sourceStatusFacet(source({ testStatus: "failed" }))).toBe("failed");
    expect(sourceStatusFacet(source({ testStatus: "empty" }))).toBe("empty");
    // No runnable adapter: there is no test outcome to report, so the row shows the capability and
    // there is no status facet. Measured, this set is exactly 适配器状态's 已阻止 + 无法适配, so
    // offering it here as well was one choice under two headings.
    expect(
      sourceStatusFacet(
        source({ capability: "blocked", siteProtocol: "spider", jar: "https://x/1.jar" }),
      ),
    ).toBeNull();
    // An invalid record is the exception: its adapter can still be runnable, so no execution choice
    // reaches it and this facet has to stay.
    expect(sourceStatusFacet(source({ capability: "invalid", api: "" }))).toBe("invalid");
  });

  it("gives a failure that never reached the server the same facet as any other", () => {
    // The row says 测试失败 for both and the switch goes off for both, so the panel must offer one
    // choice covering both. Splitting them — which this test asserted before — named a difference
    // nothing acts on: filtering to 测试失败 would hide rows the user calls 测试失败.
    const answered = source({
      testStatus: "failed",
      testMessage: "HTTP 404：接口不存在。",
    });
    const unreachable = source({
      testStatus: "failed",
      testMessage: "测试超时（25 秒），已停止等待。",
    });
    expect(sourceStatusFacet(answered)).toBe("failed");
    expect(sourceStatusFacet(unreachable)).toBe("failed");

    const onlyFailed = filter({ statuses: ["failed"] });
    expect(matchesSourceFilterState(answered, onlyFailed)).toBe(true);
    expect(matchesSourceFilterState(unreachable, onlyFailed)).toBe(true);
  });

  it("does not let a status choice match a source with no test outcome", () => {
    // Otherwise ticking 可用 would also reveal rows whose 状态 column says 已阻止. Every choice is
    // tried, not just the two that seemed likely: a mutation that gives such a source the `failed`
    // facet passed when only 可用 and 待测试 were asserted.
    const blockedSource = source({
      capability: "blocked",
      siteProtocol: "spider",
      jar: "https://x/1.jar",
    });
    for (const choice of [
      "usable",
      "untested",
      "failed",
      "empty",
      "invalid",
    ] as const) {
      expect(
        matchesSourceFilterState(blockedSource, filter({ statuses: [choice] })),
        `statuses: ["${choice}"] must not match a source with no test outcome`,
      ).toBe(false);
    }
    // It is reachable through the group that owns its word.
    expect(
      matchesSourceFilterState(blockedSource, filter({ executions: ["blocked"] })),
    ).toBe(true);
    // And its count appears in that group, not in the status group's.
    const counts = facetCounts([blockedSource], filter());
    expect(counts.executions.get("blocked")).toBe(1);
    for (const [, n] of counts.statuses) {
      expect(n).toBe(0);
    }
  });

  it("counts each choice against the other groups, not against itself", () => {
    // A count that collapsed to zero as soon as a sibling was ticked would make the panel useless
    // for exploring. With nothing selected, the adapter counts are the whole list.
    const sources = [
      source({ key: "a", testStatus: "passed" }),
      source({ key: "b", testStatus: "failed" }),
      source({ key: "c", api: "csp_XBPQ", siteProtocol: "xbpq", testStatus: "passed" }),
    ];

    const counts = facetCounts(sources, filter());
    expect(counts.adapters.get("builtin-cms")).toBe(2);
    expect(counts.adapters.get("xbpq")).toBe(1);
    expect(counts.statuses.get("usable")).toBe(2);
    expect(counts.statuses.get("failed")).toBe(1);

    // With builtin-cms selected, the adapter counts still show every adapter: the group excludes
    // itself, so the user can switch to xbpq without clearing first.
    const narrowed = facetCounts(sources, filter({ adapters: ["builtin-cms"] }));
    expect(narrowed.adapters.get("xbpq")).toBe(1);
    expect(narrowed.adapters.get("builtin-cms")).toBe(2);
    // But a different group's counts do narrow, because that group has to hold as well.
    expect(narrowed.statuses.get("failed")).toBe(1);
    expect(narrowed.statuses.get("usable")).toBe(1);
  });

  it("counts a disabled source in the enabled group", () => {
    const sources = [
      source({ key: "a", enabled: true }),
      source({ key: "b", enabled: false }),
    ];
    const counts = facetCounts(sources, filter());
    expect(counts.enabled.get("on")).toBe(1);
    expect(counts.enabled.get("off")).toBe(1);
  });

  it("toggles a choice without disturbing the others", () => {
    expect(toggleFacet([], "a" as never)).toEqual(["a"]);
    expect(toggleFacet(["a" as never], "a" as never)).toEqual([]);
    expect(toggleFacet(["a" as never], "b" as never)).toEqual(["a", "b"]);
  });

  it("reports how many groups are narrowing, for the trigger", () => {
    expect(activeFilterGroupCount(filter())).toBe(0);
    expect(activeFilterGroupCount(filter({ executions: ["enabled"] }))).toBe(1);
    expect(
      activeFilterGroupCount(
        filter({ executions: ["enabled"], statuses: ["usable"], enabled: ["on"] }),
      ),
    ).toBe(3);
    // Two choices in one group are still one group.
    expect(activeFilterGroupCount(filter({ statuses: ["usable", "failed"] }))).toBe(1);
  });

  it("knows when it is showing everything", () => {
    expect(isFilterUnfiltered(filter())).toBe(true);
    expect(isFilterUnfiltered(filter({ executions: ["enabled"] }))).toBe(false);
    // The default is a filter, not "everything", so a reset is offered on first open.
    expect(isFilterUnfiltered(defaultSourceFilter)).toBe(false);
  });
});

describe("the vocabulary shared with the adapter registry", () => {
  it("names each execution the same way the adapter column does", () => {
    // These words were written out four times — in the registry, in the filter panel, in the adapter
    // tab's dropdown and in capability-badge — so one source could be described three different ways
    // depending on the screen. The panel and the badge now read the registry's function.
    for (const execution of ["enabled", "needs-adapter", "blocked"] as const) {
      expect(executionFacetLabels[execution]).toBe(adapterStatusLabel(execution));
    }
  });

  it("says 无法适配 rather than 待适配", () => {
    // 待适配 promised that support was coming. Measured against the author's configuration that was
    // false for every source carrying it: the implementation is compiled into the TVBox client, the
    // payload is encrypted with the key in a JAR, the config points at TVBox's own loopback server,
    // or the address is dead. The word has to describe a state the user can act on.
    expect(adapterStatusLabel("needs-adapter")).toBe("无法适配");
    expect(executionFacetLabels["needs-adapter"]).toBe("无法适配");
  });

  it("gives no two choices the same word", () => {
    // Two choices reading 已阻止 while selecting different sets is worse than either being wrong: the
    // reader has no way to tell which one they want. This happened when the 测试状态 group kept a
    // `blocked` facet that the 适配器状态 group already covered exactly.
    const all = [
      ...Object.values(executionFacetLabels),
      ...Object.values(statusFacetLabels),
      ...Object.values(enabledFacetLabels),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps the two groups' sets disjoint", () => {
    // The invariant behind the duplicate-word fix: a source with a test outcome is described by the
    // 测试状态 group, and one without is described by the 适配器状态 group. No source is in both, so
    // no source can be selected by a choice from each group at once — which is what made two choices
    // both reading 已阻止 select different sets.
    const withOutcome = source({ testStatus: "failed" });
    const withOutcomeFacet = sourceStatusFacet(withOutcome);
    expect(withOutcomeFacet).toBe("failed");
    // Its word is in the status group and not in the execution group's vocabulary.
    expect(Object.values(statusFacetLabels)).toContain(
      statusFacetLabels[withOutcomeFacet as keyof typeof statusFacetLabels],
    );
    expect(Object.values(executionFacetLabels)).not.toContain("测试失败");

    // A source with no outcome returns null, so no status choice can select it.
    const noOutcome = source({
      capability: "blocked",
      siteProtocol: "spider",
      jar: "https://x/1.jar",
    });
    expect(sourceStatusFacet(noOutcome)).toBeNull();
  });
});
