import { describe, expect, it } from "vitest";

import { getCapabilityCounts, initialSources } from "@/lib/mock-data";

describe("Moseek capability classification", () => {
  it("keeps supported, partial, adapter, and blocked sources distinct", () => {
    const counts = getCapabilityCounts(initialSources);

    expect(counts.supported).toBe(8);
    expect(counts.partial).toBe(2);
    expect(counts["needs-adapter"]).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.invalid).toBe(0);
  });
});
