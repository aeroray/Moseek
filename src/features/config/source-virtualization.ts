/**
 * The source table's virtualisation arithmetic.
 *
 * Kept as a pure function rather than inline in the component because the decision it makes has a
 * failure mode that is invisible in tests and fatal in the app:
 *
 * jsdom has no layout engine — measured, `clientHeight` of a 500px-tall scroller is **0**, and the
 * project's `ResizeObserver` stub never fires a callback. A virtualiser driven by measurement
 * therefore sees an empty viewport and renders **no rows at all**, which would turn every existing
 * table assertion into "no rows found" without anything actually being broken. So the fallback is
 * explicit: with no measurable viewport, render the list in full, which is exactly what the tests
 * and any non-browser environment get.
 */

/**
 * The source table's row height.
 *
 * Measured in a real browser against the real configuration: every one of the first 30 rows is
 * exactly 53px, with no variation. A fixed size is what lets the virtualiser skip measurement, and
 * the measurement is what keeps a wrong estimate from making the scrollbar jump as rows mount.
 */
export const SOURCE_ROW_HEIGHT = 53;

/**
 * The viewport height assumed for the very first render, before anything is measured.
 *
 * The virtualiser needs a viewport to compute a window, and on the first render nothing has been
 * measured yet. Without a starting estimate it would compute an empty window, fall back to rendering
 * the whole list, and only correct itself after layout — which is the 270 ms stall this exists to
 * remove, paid once per open. 600 is deliberately generous: overestimating mounts a few extra rows,
 * underestimating would show a gap before the real measurement lands.
 */
export const INITIAL_VIEWPORT_HEIGHT = 600;

/**
 * Whether this environment has a layout engine.
 *
 * The gate that decides between windowing and rendering everything, and it is a real measurement
 * rather than a `typeof window` check: jsdom defines `window` but computes no layout, so a virtualiser
 * there measures a zero-height viewport and renders **no rows**. Measured in this project's jsdom:
 * a 500px-tall scroller reports `clientHeight` 0, and the `ResizeObserver` stub never fires a callback.
 * Rendering nothing would fail every existing table assertion while nothing was actually broken.
 *
 * Probed once per call with a real element, because that is the only honest way to ask the question.
 */
export function hasLayoutEngine(): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const probe = document.createElement("div");
  probe.style.height = "10px";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const measured = probe.getBoundingClientRect().height;
  probe.remove();
  return measured > 0;
}

export type VisibleRows = {
  /** Whether to render only the window. False means "render every row". */
  virtualize: boolean;
  /** Spacer height above the window, so the scroll position stays truthful. */
  paddingTop: number;
  /** Spacer height below the window. */
  paddingBottom: number;
};

export function resolveVisibleRows({
  rowCount,
  viewportHeight,
  virtualItems,
  totalSize,
}: {
  rowCount: number;
  /** The measured height of the scroll viewport. 0 in jsdom. */
  viewportHeight: number;
  virtualItems: Array<{ index: number; start: number; end: number }>;
  /** The virtualiser's estimate of the full list height. */
  totalSize: number;
}): VisibleRows {
  // Three ways this is not virtualisable, and all three mean "show everything" rather than "show
  // nothing": no viewport to measure, no rows to window, or an empty list.
  if (viewportHeight <= 0 || virtualItems.length === 0 || rowCount === 0) {
    return { virtualize: false, paddingTop: 0, paddingBottom: 0 };
  }

  const first = virtualItems[0];
  const last = virtualItems[virtualItems.length - 1];
  // The spacers reproduce the rows that are not mounted, so the scrollbar describes the whole list
  // rather than only the window — without them the list would appear to be ~25 rows long and the
  // scrollbar would jump on every scroll.
  const paddingTop = Math.max(0, first.start);
  const paddingBottom = Math.max(0, totalSize - last.end);
  return { virtualize: true, paddingTop, paddingBottom };
}
