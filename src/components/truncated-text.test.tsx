import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/truncated-text";

function renderText(value: string, clientWidth: number, scrollWidth: number) {
  // jsdom does no layout, so both dimensions are forced. `scrollWidth` is the full text width
  // and `clientWidth` the visible box; the component compares them.
  const spy = vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockReturnValue(clientWidth);
  const spyScroll = vi
    .spyOn(HTMLElement.prototype, "scrollWidth", "get")
    .mockReturnValue(scrollWidth);
  const result = render(
    <TooltipProvider>
      <TruncatedText>{value}</TruncatedText>
    </TooltipProvider>,
  );
  return {
    ...result,
    restore: () => {
      spy.mockRestore();
      spyScroll.mockRestore();
    },
  };
}

describe("TruncatedText", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("always ellipsises so the text cannot overflow its container", () => {
    const { restore } = renderText("很短的名字", 200, 60);
    try {
      expect(screen.getByText("很短的名字").className).toContain("truncate");
      // `min-w-0` is what lets a flex item shrink below its content width; without it
      // `truncate` never applies and the text overflows the row, which is the bug this fixes.
      expect(screen.getByText("很短的名字").className).toContain("min-w-0");
    } finally {
      restore();
    }
  });

  it("offers no tooltip when the text fits", async () => {
    // A tooltip repeating text that is already fully visible is noise on every row.
    const { restore } = renderText("短名字", 200, 60);
    try {
      await waitFor(() => {
        expect(
          document.querySelector("[data-slot='tooltip-trigger']"),
        ).toBeNull();
      });
    } finally {
      restore();
    }
  });

  it("attaches a tooltip once the text is actually clipped", async () => {
    const { restore } = renderText("非常长的频道名称".repeat(4), 80, 400);
    try {
      await waitFor(() => {
        expect(
          document.querySelector("[data-slot='tooltip-trigger']"),
        ).not.toBeNull();
      });
    } finally {
      restore();
    }
  });
});
