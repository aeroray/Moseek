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

// Measured against the real imported configuration: TVBox names the implementation in `api`
// (`api: "csp_XBPQ"`) and lets the operator pick any `key`. These fixtures use real pairs from
// that configuration.
describe("CSP family identification", () => {
  it("identifies the implementation from api when the key is an arbitrary name", () => {
    // Real source: key "fok", name "🌙┃夸克┃影视", api "csp_XBPQ".
    const profile = getAdapterProfile(
      source({
        key: "fok",
        api: "csp_XBPQ",
        siteProtocol: "spider",
        capability: "blocked",
        jar: "https://example.com/1.jar",
      }),
    );

    expect(profile.id).toBe("xbpq");
  });

  it("identifies every csp_ family from api regardless of key", () => {
    const cases: Array<[string, string]> = [
      ["fok", "csp_XBPQ"],
      ["奈飞中文", "csp_XYQHiker"],
      ["南坊", "csp_AppMao"],
      ["某短剧", "csp_Panda"],
    ];
    for (const [key, api] of cases) {
      const profile = getAdapterProfile(
        source({ key, api, siteProtocol: "spider", capability: "blocked" }),
      );
      expect(profile.id, `${api} with key "${key}"`).not.toBe("remote-jar");
      expect(profile.id, `${api} with key "${key}"`).not.toBe("spider-runtime");
    }
  });

  it("still recognises the family from the key when api carries no csp_ marker", () => {
    const profile = getAdapterProfile(
      source({ key: "csp_XBPQ", api: "https://example.com/api", siteProtocol: "spider" }),
    );

    expect(profile.id).toBe("xbpq");
  });
});
