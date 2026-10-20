import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceRecord } from "@/types/moseek";
import {
  clearedSourceFilter,
  type SourceFilterState,
} from "@/features/config/source-filter";

/**
 * How often the panel recomputes its facet counts.
 *
 * **A memoisation has no observable output to assert on, so this asserts the work it removes.** The
 * panel re-renders on every keystroke in the search box and on every batch of source tests, and
 * `facetCounts` walks the whole source list four times per call (once per facet group). React
 * Compiler is not enabled in this project — `vite.config.ts` registers only `react()` and
 * `tailwindcss()`, and there is no `babel-plugin-react-compiler` in `package.json` — so without an
 * explicit `useMemo` every one of those renders pays the full cost again.
 *
 * The test re-renders with the **same** `sources` and `value` references, which is the real shape of
 * the problem: typing a query changes neither. Exactly one count for one mount is what the memo
 * guarantees, and a second render without it is the failure.
 */
const facetCountsCalls = vi.fn();

vi.mock("@/features/config/source-filter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/config/source-filter")>();
  return {
    ...actual,
    facetCounts: (...args: Parameters<typeof actual.facetCounts>) => {
      facetCountsCalls(...args);
      return actual.facetCounts(...args);
    },
  };
});

const { SourceFilterFacets } = await import(
  "@/features/config/source-filter-panel"
);

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    key: "s",
    name: "源",
    sourceType: "cms",
    api: "https://example.com/api.php/provide/vod",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "可以正常使用。",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
    ...overrides,
  };
}

describe("SourceFilterFacets facet counting", () => {
  beforeEach(() => {
    facetCountsCalls.mockClear();
  });
  afterEach(cleanup);

  it("counts once per mount, not once per render", () => {
    // Two reference-stable inputs, which is what an unrelated re-render produces: the search box
    // updates `query` in the parent, while `sources` and the filter stay the same objects.
    const sources = [source(), source({ key: "t", name: "另一个源" })];
    const value: SourceFilterState = clearedSourceFilter;

    const { rerender } = render(
      <SourceFilterFacets sources={sources} value={value} onChange={() => {}} />,
    );
    expect(facetCountsCalls).toHaveBeenCalledTimes(1);

    // The renders a keystroke produces.
    rerender(<SourceFilterFacets sources={sources} value={value} onChange={() => {}} />);
    rerender(<SourceFilterFacets sources={sources} value={value} onChange={() => {}} />);

    // Without the `useMemo`, this is 3 — one full four-pass walk of the source list per render.
    expect(facetCountsCalls).toHaveBeenCalledTimes(1);
  });

  it("recounts when the sources or the filter actually change", () => {
    // The other direction: a memo that never invalidated would show stale counts, which is worse
    // than the cost it saves. A batch of test results replaces `sources`, and a tick replaces `value`.
    const sources = [source()];
    const value: SourceFilterState = clearedSourceFilter;

    const { rerender } = render(
      <SourceFilterFacets sources={sources} value={value} onChange={() => {}} />,
    );
    expect(facetCountsCalls).toHaveBeenCalledTimes(1);

    rerender(
      <SourceFilterFacets
        sources={[...sources, source({ key: "u" })]}
        value={value}
        onChange={() => {}}
      />,
    );
    expect(facetCountsCalls).toHaveBeenCalledTimes(2);

    rerender(
      <SourceFilterFacets
        sources={[...sources, source({ key: "u" })]}
        value={{ ...clearedSourceFilter, enabled: ["on"] }}
        onChange={() => {}}
      />,
    );
    expect(facetCountsCalls).toHaveBeenCalledTimes(3);
  });
});
