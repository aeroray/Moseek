import { describe, expect, it } from "vitest";

import { getAdapterProfile } from "@/lib/adapters";
import type { SourceRecord } from "@/types/moseek";

function source(overrides: Partial<SourceRecord>): SourceRecord {
  return {
    key: "demo",
    name: "Demo",
    sourceType: "cms",
    api: "https://example.com/api",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "demo",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
    ...overrides,
  };
}

describe("adapter registry", () => {
  it("routes ordinary type-3 style HTTP CMS sources to the built-in adapter", () => {
    const profile = getAdapterProfile(source({ key: "ordinary-type-3" }));

    expect(profile.id).toBe("builtin-cms");
    expect(profile.execution).toBe("enabled");
    expect(profile.operations).toContain("详情");
  });

  it("keeps remote code and JAR paths outside the executable adapter set", () => {
    expect(
      getAdapterProfile(
        source({
          key: "drpy_js_demo",
          sourceType: "parser",
          capability: "blocked",
        }),
      ).execution,
    ).toBe("blocked");
    expect(
      getAdapterProfile(
        source({
          key: "csp_XBPQ_demo",
          sourceType: "parser",
          capability: "needs-adapter",
        }),
      ).id,
    ).toBe("xbpq");
    expect(
      getAdapterProfile(
        source({
          jar: "https://example.com/adapter.jar",
          capability: "partial",
        }),
      ).id,
    ).toBe("remote-jar");
  });

  it("uses explicit site protocols instead of capability to identify sources", () => {
    const profile = getAdapterProfile(
      source({
        siteProtocol: "http-extension",
        capability: "supported",
      }),
    );

    expect(profile.id).toBe("http-extension");
    expect(profile.execution).toBe("enabled");
  });

  it("uses the live adapter for live sources", () => {
    const profile = getAdapterProfile(
      source({ sourceType: "live", capability: "supported" }),
    );

    expect(profile.id).toBe("builtin-live");
    expect(profile.operations).toContain("节目单");
  });
});
