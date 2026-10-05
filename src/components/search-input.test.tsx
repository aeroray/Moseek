import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchInput } from "@/components/search-input";

/**
 * The shared search field.
 *
 * It exists because the same field was written out four times and had drifted — two copies had no way
 * to clear the query at all, and each positioned its own leading icon by hand. These tests pin the
 * two things the copies disagreed about, so a future edit to one caller cannot quietly lose them.
 */
function renderInput(value = "", onValueChange = vi.fn()) {
  render(
    <SearchInput
      value={value}
      onValueChange={onValueChange}
      placeholder="搜索源名称"
      aria-label="搜索源名称"
    />,
  );
  return { onValueChange };
}

describe("SearchInput", () => {
  afterEach(cleanup);

  it("offers no clear button while the field is empty", () => {
    // The button's presence is itself the signal that there is something to clear. Showing it on an
    // empty field would make it a permanent piece of chrome that does nothing.
    renderInput("");

    expect(
      screen.queryByRole("button", { name: "清除搜索" }),
    ).not.toBeInTheDocument();
  });

  it("clears the query when the button is pressed", () => {
    // Without this, undoing a search means selecting the text and deleting it by hand.
    const { onValueChange } = renderInput("海贼王");

    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));

    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it("keeps the clear button reachable by its accessible name, not just a tooltip", () => {
    // It is an icon-only control, so the label is the name; a `title` alone is not a name and leaves
    // the button announced as nothing.
    renderInput("海贼王");

    const clear = screen.getByRole("button", { name: "清除搜索" });
    expect(clear).toHaveAttribute("title", "清除搜索");
  });

  it("reports what the user types", () => {
    const { onValueChange } = renderInput("");

    fireEvent.change(screen.getByLabelText("搜索源名称"), {
      target: { value: "央视" },
    });

    expect(onValueChange).toHaveBeenCalledWith("央视");
  });

  it("leaves room for both the icon and the clear button", () => {
    // The two affordances sit at either end of a fixed-height field. Without the padding the text
    // runs underneath them, which is how the hand-positioned copies looked once the button was added.
    renderInput("x");

    const input = screen.getByLabelText("搜索源名称");
    expect(input.className).toContain("pl-8");
    expect(input.className).toContain("pr-8");
  });

  it("hides the platform's own search clear control", () => {
    // WebKit renders one for `type="search"` on Windows, which would appear beside ours and do the
    // same thing twice.
    renderInput("x");

    const input = screen.getByLabelText("搜索源名称");
    expect(input.className).toContain("[&::-webkit-search-cancel-button]:appearance-none");
  });
});
