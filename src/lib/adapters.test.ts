import { describe, expect, it } from "vitest";

import {
  adapterStatusLabel,
  getAdapterProfile,
  hasScriptArchive,
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
          capability: "blocked",
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

  it("lets the adapter decide testability, not the stored capability", () => {
    expect(isTestableCmsSource(source({ testStatus: "untested" }))).toBe(true);
    // The adapter has a code path, so the source is testable even though its stored capability
    // predates that support. Requiring `capability === "supported"` here left 60 sources with a
    // working XBPQ adapter permanently untestable and missing from the movie library.
    expect(
      isTestableCmsSource(
        source({ capability: "blocked", siteProtocol: "http-extension" }),
      ),
    ).toBe(true);
    expect(isTestableCmsSource(source({ sourceType: "live" }))).toBe(false);
    expect(isTestableLiveSource(source({ sourceType: "live" }))).toBe(true);
    expect(isTestableSource(source({ sourceType: "live" }))).toBe(true);
    // A live source whose adapter exists is testable regardless of a stale stored capability.
    expect(
      isTestableLiveSource(source({ sourceType: "live", capability: "blocked" })),
    ).toBe(true);
    // An unparseable record is the one hard stop: no adapter can build a request from it.
    expect(
      isTestableLiveSource(source({ sourceType: "live", capability: "invalid" })),
    ).toBe(false);
    expect(
      isTestableCmsSource(source({ capability: "invalid", siteProtocol: "http-extension" })),
    ).toBe(false);
    // An adapter that cannot run still decides, and it says no.
    expect(
      isTestableCmsSource(source({ siteProtocol: "spider", jar: "https://x/1.jar" })),
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
    ).toBe(true);
    expect(
      isMovieLibrarySource(source({ enabled: false, testStatus: "passed" })),
    ).toBe(false);
    // There is no second predicate any more: the fallback that used to exist ran the same
    // filter, so an untested enabled source is simply listed.
    expect(isMovieLibrarySource(source({ testStatus: "untested" }))).toBe(true);
  });

  it("treats a bound script archive as present only when it is a number", () => {
    // `scriptArchiveId` is optional, so both `null` and `undefined` mean "not bound". The same
    // two-part check was written out seven times across the codebase; this pins the one copy.
    expect(hasScriptArchive(source({ scriptArchiveId: 7 }))).toBe(true);
    expect(hasScriptArchive(source({ scriptArchiveId: 0 }))).toBe(true);
    expect(hasScriptArchive(source({ scriptArchiveId: null }))).toBe(false);
    expect(hasScriptArchive(source({ scriptArchiveId: undefined }))).toBe(false);
  });

  it("names the execution states the way the interface does", () => {
    // One source, one word, whichever screen shows it.
    expect(adapterStatusLabel("enabled")).toBe("可执行");
    expect(adapterStatusLabel("needs-adapter")).toBe("无法适配");
    expect(adapterStatusLabel("blocked")).toBe("已阻止");
  });

  it("does not blame a missing sandbox for a source blocked by something else", () => {
    // The drpy reason said 未提供 JS 沙箱, which was false twice: a QuickJS sandbox has existed
    // since the script-runtime sidecar was added, and it is not what stops these sources — measured,
    // 9 of the 10 distinct script addresses are unusable, and running one would need a host API
    // layer (`request`, `pdfa`/`pdfh`, `CryptoJS`) the sandbox does not provide. Telling the reader
    // a sandbox is missing sends them looking for a switch that would change nothing.
    const drpy = getAdapterProfile(
      source({ key: "drpy-one", api: "https://example.com/lib/drpy2.min.js" }),
    );
    expect(drpy.id).toBe("drpy-js");
    expect(drpy.reason).not.toContain("沙箱");
    // It names what is actually required instead.
    expect(drpy.reason).toContain("宿主 API");

    // A CatVod JS source is blocked because no archive is bound to it, not because the sandbox is
    // absent — binding one moves the source to `local-script`, which runs.
    const jsExtension = getAdapterProfile(
      source({ key: "kitty", siteProtocol: "js-extension" }),
    );
    expect(jsExtension.id).toBe("js-extension");
    expect(jsExtension.reason).not.toContain("没有启用脚本沙箱");
    expect(jsExtension.reason).toContain("绑定本地脚本档案");
  });
});
