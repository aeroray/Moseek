import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Input } from "@/components/ui/input";
import { Select, SelectTrigger } from "@/components/ui/select";
import { Toast, ToastIcon, ToastProvider, ToastTitle } from "@/components/ui/toast";

// SelectTrigger reads Radix's Select context, so it must be rendered inside a Select root.
function renderTrigger(props: React.ComponentProps<typeof SelectTrigger>) {
  return render(
    <Select>
      <SelectTrigger {...props} />
    </Select>,
  );
}

// jsdom performs no CSS cascade, so these tests assert the class contract that the cascade
// depends on rather than a computed style. That contract is what broke: a `data-[size=*]`
// variant scores (0,1,2) and silently outranks a caller's plain `pl-8` at (0,1,0), so the
// override was dropped and the search icon sat on top of the placeholder text.
describe("Input size contract", () => {
  afterEach(cleanup);

  it("does not use data-attribute variants for size, so callers can override padding", () => {
    render(<Input size="sm" className="pl-8" aria-label="probe" />);
    const input = screen.getByLabelText("probe");

    expect(input.className).not.toMatch(/data-\[size=/);
    expect(input.className).toContain("pl-8");
    // The right side must survive from the base rule, otherwise the override would have
    // been merged by a `px-*` shorthand and silently reset the opposite edge.
    expect(input.className).toContain("pr-2.5");
  });

  it("lets both edges be overridden independently", () => {
    render(<Input size="sm" className="pl-8 pr-14" aria-label="probe" />);
    const input = screen.getByLabelText("probe");

    expect(input.className).toContain("pl-8");
    expect(input.className).toContain("pr-14");
    expect(input.className).not.toContain("pr-2.5");
  });

  it("keeps the default size metrics when no override is passed", () => {
    render(<Input aria-label="probe" />);

    expect(screen.getByLabelText("probe").className).toContain("h-9");
  });

  it("keeps the small size metrics when size=sm is passed", () => {
    render(<Input size="sm" aria-label="probe" />);

    expect(screen.getByLabelText("probe").className).toContain("h-8");
  });
});

describe("SelectTrigger size contract", () => {
  afterEach(cleanup);

  it("does not use data-attribute variants for size", () => {
    renderTrigger({ size: "sm", "aria-label": "probe" });

    const trigger = screen.getByLabelText("probe");
    expect(trigger.className).not.toMatch(/data-\[size=/);
    expect(trigger.className).toContain("h-8");
  });

  it("scales the chevron down for the small size instead of leaving the base rule", () => {
    renderTrigger({ size: "sm", "aria-label": "probe" });

    const trigger = screen.getByLabelText("probe");
    // Exactly one svg sizing rule may reach the element: a shared `size-4` base plus a
    // `size-3.5` small rule would leave both in the class list, and CSS source order (not
    // the intended size) would decide which one wins.
    const svgRules = trigger.className.match(/\[&_svg:not\(\[class\*='size-'\]\)\]:size-/g);
    expect(svgRules).toHaveLength(1);
    expect(trigger.className).toContain("size-3.5");
  });

  it("uses the larger chevron at the default size", () => {
    renderTrigger({ "aria-label": "probe" });

    expect(screen.getByLabelText("probe").className).toContain("size-4");
  });
});

/**
 * The toast surface.
 *
 * **The reported defect.** A success notice painted its whole panel with `--status-supported-bg`, a
 * 12%-opacity green designed for a small badge in a table cell. Filled across a 24rem panel it read as
 * a different application — the interface is obsidian cards with a hairline border and one accent
 * colour. These assertions pin the surface to the app's own card language so the fill cannot come back
 * one variant at a time.
 */
describe("Toast surface contract", () => {
  afterEach(cleanup);

  function renderToast(variant: "info" | "success" | "error") {
    render(
      // Radix requires the provider: the viewport it renders is where the toast is portalled to.
      <ToastProvider>
        <Toast variant={variant} open>
          <ToastIcon variant={variant} />
          <ToastTitle>标题</ToastTitle>
        </Toast>
      </ToastProvider>,
    );
    return document.querySelector("[data-slot='toast']") as HTMLElement;
  }

  it("keeps every variant on the app's own card surface", () => {
    // The body is the card, whatever the outcome. Only the icon and (for a failure) the border carry
    // the colour, which is the same division `CapabilityBadge` uses.
    for (const variant of ["info", "success", "error"] as const) {
      cleanup();
      const toast = renderToast(variant);

      expect(toast.className, variant).toContain("bg-card/95");
      // The status tints are for badges. None of them may reach the panel.
      expect(toast.className, variant).not.toContain("status-supported-bg");
      expect(toast.className, variant).not.toContain("status-blocked-bg");
      expect(toast.className, variant).not.toContain("bg-destructive/10");
      // The project's overlay language: a real shadow plus a blur, never a flat box.
      expect(toast.className, variant).toContain("shadow-xl");
      expect(toast.className, variant).toContain("backdrop-blur-md");
    }
  });

  it("marks a failure on the border, which is the one variant worth the extra signal", () => {
    const toast = renderToast("error");
    expect(toast.className).toContain("border-destructive/40");
  });

  it("tints the icon instead, so the outcome is still legible", () => {
    // Removing the fill must not remove the meaning: the icon carries it, in the same colour pairing
    // a 可用 badge uses for the same fact.
    cleanup();
    render(
      <ToastProvider>
        <Toast variant="success" open>
          <ToastIcon variant="success" />
          <ToastTitle>标题</ToastTitle>
        </Toast>
      </ToastProvider>,
    );
    const ring = document.querySelector("[data-slot='toast'] span[aria-hidden='true']");
    expect(ring?.className).toContain("bg-[color:var(--status-supported-bg)]");
    expect(ring?.className).toContain("text-[color:var(--status-supported)]");
  });
});
