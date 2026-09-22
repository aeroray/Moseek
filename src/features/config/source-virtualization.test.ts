import { describe, expect, it } from "vitest";

import {
  SOURCE_ROW_HEIGHT,
  hasLayoutEngine,
  resolveVisibleRows,
} from "@/features/config/source-virtualization";

describe("the layout probe", () => {
  it("reports no layout engine in jsdom, which is what makes the tests keep passing", () => {
    // Measured, not assumed: jsdom has no layout, so a 10px element reports 0. This is the switch that
    // makes the table render every row in tests — and it must therefore be false here. If jsdom ever
    // gains a layout engine this fails loudly, rather than the table silently rendering nothing.
    expect(hasLayoutEngine()).toBe(false);
  });

  it("leaves nothing behind in the DOM", () => {
    // The probe appends an element to measure it. Leaking one per render would grow the DOM on every
    // keystroke in the dialog, which is the opposite of the point.
    const before = document.body.childElementCount;
    hasLayoutEngine();
    hasLayoutEngine();
    expect(document.body.childElementCount).toBe(before);
  });
});

describe("source table virtualisation", () => {
  const items = [
    { index: 10, start: 530, end: 583 },
    { index: 11, start: 583, end: 636 },
    { index: 12, start: 636, end: 689 },
  ];

  it("windows the rows and pads the rest", () => {
    const result = resolveVisibleRows({
      rowCount: 358,
      viewportHeight: 497,
      virtualItems: items,
      totalSize: 358 * SOURCE_ROW_HEIGHT,
    });

    expect(result.virtualize).toBe(true);
    // The rows above the window are reserved, not dropped: without this the scrollbar would describe
    // a 25-row list and jump on every scroll.
    expect(result.paddingTop).toBe(530);
    // 358 * 53 = 18974, minus the last row's end (689).
    expect(result.paddingBottom).toBe(358 * SOURCE_ROW_HEIGHT - 689);
    // The spacers plus the window must add up to the whole list, or the scrollbar lies.
    expect(result.paddingTop + (689 - 530) + result.paddingBottom).toBe(
      358 * SOURCE_ROW_HEIGHT,
    );
  });

  it("renders every row when the viewport cannot be measured", () => {
    // This is jsdom, and it is not a hypothetical: measured there, a 500px-tall scroller reports
    // clientHeight 0 and the ResizeObserver stub never fires. Virtualising on that would render NO
    // rows and fail every table assertion while nothing was actually broken.
    //
    // The virtual items are deliberately NON-empty here. With an empty array the `virtualItems.length`
    // guard alone would produce the right answer and this test would pass even if the viewport check
    // were deleted — which is exactly what a mutation showed. A non-empty window with a zero-height
    // viewport is the case that isolates the check under test.
    const result = resolveVisibleRows({
      rowCount: 358,
      viewportHeight: 0,
      virtualItems: items,
      totalSize: 358 * SOURCE_ROW_HEIGHT,
    });

    expect(result.virtualize).toBe(false);
    expect(result.paddingTop).toBe(0);
    expect(result.paddingBottom).toBe(0);
  });

  it("renders every row when the list is empty", () => {
    const result = resolveVisibleRows({
      rowCount: 0,
      viewportHeight: 497,
      virtualItems: [],
      totalSize: 0,
    });
    expect(result.virtualize).toBe(false);
  });

  it("still virtualises a short list, because the window is all of it", () => {
    // A list shorter than the viewport has a window equal to itself; padding is zero and the result
    // is indistinguishable from not virtualising. Asserted so the boundary is pinned rather than
    // assumed — this is the case that made "always render all when short" unnecessary.
    const short = [
      { index: 0, start: 0, end: 53 },
      { index: 1, start: 53, end: 106 },
    ];
    const result = resolveVisibleRows({
      rowCount: 2,
      viewportHeight: 497,
      virtualItems: short,
      totalSize: 106,
    });
    expect(result.virtualize).toBe(true);
    expect(result.paddingTop).toBe(0);
    expect(result.paddingBottom).toBe(0);
  });

  it("never returns a negative spacer", () => {
    // Defensive: a virtualiser that reports a total smaller than the last item's end would otherwise
    // produce a negative height, which React renders as an invalid style.
    const result = resolveVisibleRows({
      rowCount: 3,
      viewportHeight: 497,
      virtualItems: [{ index: 2, start: 106, end: 200 }],
      totalSize: 159,
    });
    expect(result.paddingBottom).toBe(0);
  });
});
