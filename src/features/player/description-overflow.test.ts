import { describe, expect, it } from "vitest";

import { descriptionOverflows } from "@/features/player/player-view";

// The synopsis clamp hides text, so the tooltip is what makes it lossless. Whether a tooltip is
// attached is decided by measuring the clamped element rather than by guessing from the text
// length: a character count was tried first and was wrong in both directions — it attached a
// pointless tooltip to 130 characters of CJK that fit in three lines, and would miss a narrow
// window where 140 characters overflow.
//
// jsdom performs no layout, so the element cannot be measured here. These tests drive the
// decision function with the numbers a real layout would produce, which is the part that has the
// logic in it.
function fakeElement(scrollHeight: number, clientHeight: number) {
  return { scrollHeight, clientHeight } as HTMLParagraphElement;
}

describe("descriptionOverflows", () => {
  it("reports overflow when the clamped content is taller than its box", () => {
    expect(descriptionOverflows(fakeElement(120, 39))).toBe(true);
  });

  it("reports no overflow when the content fits", () => {
    expect(descriptionOverflows(fakeElement(39, 39))).toBe(false);
  });

  it("tolerates sub-pixel rounding at the boundary", () => {
    // A one-pixel difference is rounding, not a hidden line, and would otherwise attach a
    // tooltip that repeats fully visible text.
    expect(descriptionOverflows(fakeElement(40, 39))).toBe(false);
    expect(descriptionOverflows(fakeElement(41, 39))).toBe(true);
  });

  it("assumes overflow when the environment reports no layout at all", () => {
    // jsdom reports zero heights for every element. Treating that as "it fits" would mean the
    // tooltip is never rendered in any test, so the branch would ship unexercised.
    expect(descriptionOverflows(fakeElement(0, 0))).toBe(true);
  });

  it("assumes no overflow for a missing element", () => {
    expect(descriptionOverflows(null)).toBe(false);
  });
});
