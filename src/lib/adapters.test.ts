import { describe, expect, it } from "vitest";

import {
  getAdapterProfile,
  isMovieLibrarySource,
  isTestableCmsSource,
  isTestableLiveSource,
  isTestableSource,
} from "@/lib/adapters";
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

  it("treats the safe HTTP parser and bound local scripts as executable adapters", () => {
    expect(
      getAdapterProfile(
        source({
          sourceType: "parser",
          key: "parse-post",
          api: "https://parser.example/resolve",
        }),
      ).execution,
    ).toBe("enabled");
    expect(
      getAdapterProfile(
        source({
          key: "kitty-js",
          siteProtocol: "js-extension",
          capability: "blocked",
          scriptArchiveId: 7,
        }),
      ).execution,
    ).toBe("enabled");
  });

  it("uses the live adapter for live sources", () => {
    const profile = getAdapterProfile(
      source({ sourceType: "live", capability: "supported" }),
    );

    expect(profile.id).toBe("builtin-live");
    expect(profile.operations).toContain("节目单");
  });

  it("requires an executable CMS and a passed probe for the movie library", () => {
    expect(isTestableCmsSource(source({ testStatus: "untested" }))).toBe(true);
    expect(
      isTestableCmsSource(
        source({ capability: "partial", siteProtocol: "http-extension" }),
      ),
    ).toBe(false);
    expect(isTestableCmsSource(source({ sourceType: "live" }))).toBe(false);
    expect(isTestableLiveSource(source({ sourceType: "live" }))).toBe(true);
    expect(isTestableSource(source({ sourceType: "live" }))).toBe(true);
    expect(
      isTestableLiveSource(
        source({ sourceType: "live", capability: "partial" }),
      ),
    ).toBe(false);
    // Listing in the movie library depends on being enabled, not on having been audited. A test
    // the user has not run yet is not a reason to hide a source they turned on.
    expect(isMovieLibrarySource(source({ testStatus: "untested" }))).toBe(true);
    expect(isMovieLibrarySource(source({ testStatus: "passed" }))).toBe(true);
    // A source that fails or returns nothing is switched off by the test run, so it drops out
    // through `enabled` rather than through its status.
    expect(isMovieLibrarySource(source({ testStatus: "empty", enabled: false }))).toBe(false);
    expect(isMovieLibrarySource(source({ testStatus: "failed", enabled: false }))).toBe(false);
    expect(
      isMovieLibrarySource(
        source({ capability: "blocked", testStatus: "passed" }),
      ),
    ).toBe(false);
    expect(
      isMovieLibrarySource(source({ enabled: false, testStatus: "passed" })),
    ).toBe(false);
    // There is no second predicate any more: the fallback that used to exist ran the same
    // filter, so an untested enabled source is simply listed.
    expect(isMovieLibrarySource(source({ testStatus: "untested" }))).toBe(true);
  });
});
