import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The font stacks are the one part of the design that no DOM assertion can check: jsdom does not
 * resolve font fallbacks, and a browser will silently substitute a face for glyphs the stack does
 * not cover. These tests pin the contract that makes the substitution land in the right place.
 *
 * The defect they exist for: `--font-mono` ended at the generic `monospace` keyword, which covers
 * Chinese through the system's own fallback. So a source whose key is 电影天堂 was painted in a
 * different face from the same text everywhere else on the page — the 标识 row looked wrong beside
 * its own neighbours. Measured in Chrome by hashing the painted pixels: the CJK string rendered
 * differently under the mono stack and the sans stack.
 */
const stylesheet = readFileSync(
  path.join(process.cwd(), "src", "index.css"),
  "utf8",
);

function tokenValue(name: string) {
  const match = stylesheet.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`--${name} not found in index.css`);
  return match[1].trim();
}

describe("font stacks", () => {
  it("keeps the sans fallback chain in the mono stack", () => {
    // The generic `monospace` keyword must come last, and the sans chain before it, so CJK glyphs
    // resolve exactly where the rest of the UI resolves them.
    const mono = tokenValue("font-mono");
    const sans = tokenValue("font-sans");

    expect(sans).toContain("sans-serif");
    expect(mono).toContain("var(--font-sans)");
    expect(mono.indexOf("var(--font-sans)")).toBeLessThan(
      mono.lastIndexOf("monospace"),
    );
    // The chain is spliced in wholesale rather than partially retyped. A retyped copy would be free
    // to drift from --font-sans, and that drift is exactly how the CJK mismatch would return.
    expect(mono).toMatch(/var\(--font-sans\),\s*monospace$/);
  });

  it("still ends the mono stack with a monospace keyword", () => {
    // Latin text must keep its monospace advance: the CJK fix must not turn ids and URLs
    // proportional. Measured: 57.61px for `csp_XBPQ` either way.
    expect(tokenValue("font-mono").trimEnd().endsWith("monospace")).toBe(true);
  });

  it("keeps the mono fonts ahead of the sans chain", () => {
    // Order matters in the other direction too: the mono faces have to win for Latin, or every
    // id and URL would render proportional.
    const mono = tokenValue("font-mono");
    const firstMono = mono.indexOf("ui-monospace");
    expect(firstMono).toBeGreaterThanOrEqual(0);
    expect(firstMono).toBeLessThan(mono.indexOf("var(--font-sans)"));
  });

  it("registers the mono token in the theme block", () => {
    // Tailwind only emits a `font-mono` utility for a token it knows about. Without the
    // registration the token above is inert and `font-mono` falls back to Tailwind's default
    // stack, which is the very stack that had no CJK coverage.
    expect(stylesheet).toMatch(/--font-mono:\s*var\(--font-mono\);/);
  });
});
