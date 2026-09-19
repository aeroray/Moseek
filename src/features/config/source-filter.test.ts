import { describe, expect, it } from "vitest";

import {
  activeFilterGroupCount,
  defaultSourceFilter,
  facetCounts,
  isFilterUnfiltered,
  matchesSourceFilterState,
  sourceStatusFacet,
  toggleFacet,
  type SourceFilterState,
} from "@/features/config/source-filter";
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
    // No runnable adapter: there is no test outcome to report, so the row shows the capability.
    expect(
      sourceStatusFacet(
        source({ capability: "blocked", siteProtocol: "spider", jar: "https://x/1.jar" }),
      ),
    ).toBe("blocked");
    expect(sourceStatusFacet(source({ capability: "invalid", api: "" }))).toBe("invalid");
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
