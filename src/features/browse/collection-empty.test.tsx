import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollectionEmpty } from "@/features/browse/collection-empty";

/**
 * The shared empty state for 我的收藏 and 足迹.
 *
 * The defect it fixes: the two pages each had their own wrapper, and they centred against different
 * boxes. Measured in a real browser with an empty store, the empty box sat **52px** from the top of
 * the content area on one page and **97px** on the other.
 *
 *  - 我的收藏: `flex h-full items-center justify-center p-8` — `h-full` cannot resolve against an
 *    auto-height parent, so it collapsed to the content box and the padding decided the position.
 *  - 足迹: `flex h-96 items-center justify-center` — a fixed 384px, a number unrelated to the
 *    viewport it sat in.
 *
 * Both now render this component, whose own `min-h-80` gives a definite height that does not depend
 * on resolving a percentage through Radix's viewport wrapper.
 */
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

describe("CollectionEmpty", () => {
  afterEach(cleanup);

  it("puts the box on a definite minimum height instead of a percentage", () => {
    // The specific failure: `h-full` silently does nothing here, so the two pages disagreed about
    // where the box goes. A definite min-height is what makes them agree.
    render(
      <CollectionEmpty
        icon={<span />}
        title="还没有收藏"
        description="说明文字"
        actionLabel="浏览影视库"
        onAction={() => {}}
      />,
    );

    const box = document.querySelector('[data-slot="empty"]');
    expect(box?.className).toContain("min-h-80");
    expect(box?.className).not.toContain("h-full");
    expect(box?.className).not.toContain("h-96");
  });

  it("renders the icon, title, description and action", () => {
    const onAction = vi.fn();
    render(
      <CollectionEmpty
        icon={<span data-testid="icon" />}
        title="还没有足迹"
        description="在影视库点开任意影片。"
        actionLabel="去影视库看看"
        onAction={onAction}
      />,
    );

    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByText("还没有足迹")).toBeInTheDocument();
    expect(screen.getByText("在影视库点开任意影片。")).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "去影视库看看" });
    action.click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("does not centre against a padding box", () => {
    // The wrapper is what centres; the padding that used to sit on it is gone, because that padding
    // was what the `h-full` collapse fell back to and it is what put the two pages 45px apart.
    render(
      <CollectionEmpty
        icon={<span />}
        title="还没有收藏"
        description="说明文字"
        actionLabel="浏览影视库"
        onAction={() => {}}
      />,
    );

    const wrapper = document.querySelector('[data-slot="empty"]')?.parentElement;
    expect(wrapper?.className).toContain("items-center");
    expect(wrapper?.className).toContain("justify-center");
    expect(wrapper?.className).not.toContain("p-8");
    expect(wrapper?.className).not.toContain("h-full");
  });
});
