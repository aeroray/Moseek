import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Checkbox } from "@/components/ui/checkbox";

/**
 * The filter panel's row is a click target that contains a checkbox, so a click has to count once.
 *
 * These are the measurements the panel's shape is based on, kept as tests so the reasoning survives
 * the next change to the row.
 */

/** The panel's shape: the row handles the click, the checkbox is presentation only. */
function RowHandles({ pointerEventsNone }: { pointerEventsNone: boolean }) {
  const [value, setValue] = useState<string[]>([]);
  const [calls, setCalls] = useState(0);
  const toggle = () => {
    setCalls((count) => count + 1);
    setValue(value.includes("x") ? value.filter((item) => item !== "x") : [...value, "x"]);
  };
  return (
    <div onClick={toggle} data-testid="row">
      <Checkbox
        checked={value.includes("x")}
        aria-label="选项"
        className={pointerEventsNone ? "pointer-events-none" : undefined}
      />
      <span data-testid="state">{value.includes("x") ? "选中" : "未选"}</span>
      <span data-testid="calls">{calls}</span>
    </div>
  );
}

/** The shape that was wrong: both the box and the row handle the same click. */
function BothHandle() {
  const [value, setValue] = useState<string[]>([]);
  const [calls, setCalls] = useState(0);
  const toggle = () => {
    setCalls((count) => count + 1);
    setValue(value.includes("x") ? value.filter((item) => item !== "x") : [...value, "x"]);
  };
  return (
    <div onClick={toggle} data-testid="row">
      <Checkbox
        checked={value.includes("x")}
        onCheckedChange={toggle}
        aria-label="选项"
      />
      <span data-testid="state">{value.includes("x") ? "选中" : "未选"}</span>
      <span data-testid="calls">{calls}</span>
    </div>
  );
}

describe("a checkbox inside a clickable row", () => {
  afterEach(cleanup);

  it("toggles exactly once when the box is clicked", () => {
    render(<RowHandles pointerEventsNone />);

    fireEvent.click(screen.getByRole("checkbox", { name: "选项" }));

    expect(screen.getByTestId("state")).toHaveTextContent("选中");
    // Exactly one toggle, not two. A second would be two renders for one click.
    expect(screen.getByTestId("calls")).toHaveTextContent("1");
  });

  it("toggles exactly once when the row is clicked", () => {
    render(<RowHandles pointerEventsNone />);

    fireEvent.click(screen.getByTestId("row"));

    expect(screen.getByTestId("state")).toHaveTextContent("选中");
    expect(screen.getByTestId("calls")).toHaveTextContent("1");
  });

  it("toggles exactly once when the box is activated by keyboard", () => {
    // A `<button>` turns Space into a click that bubbles, so the row sees it. This is why the
    // checkbox does not need a handler of its own to be reachable by keyboard.
    render(<RowHandles pointerEventsNone />);

    const box = screen.getByRole("checkbox", { name: "选项" });
    box.focus();
    fireEvent.click(box);

    expect(screen.getByTestId("calls")).toHaveTextContent("1");
  });

  it("fires twice when both the box and the row handle the click", () => {
    // Pins why the row is the only handler. The state still lands correctly here — the update is
    // computed from the closure's value, so both calls produce the same next value — which is
    // exactly why this needs asserting on the call count rather than on the visible state.
    render(<BothHandle />);

    fireEvent.click(screen.getByRole("checkbox", { name: "选项" }));

    expect(screen.getByTestId("calls")).toHaveTextContent("2");
    expect(screen.getByTestId("state")).toHaveTextContent("选中");
  });
});
