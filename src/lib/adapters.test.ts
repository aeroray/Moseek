import { describe, expect, it } from "vitest";

import {
  adapterStatusLabel,
  getAdapterProfile,
  hasScriptArchive,
  isFetchableLiveUrl,
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

  it("refuses a live source whose address is not a fetchable HTTP URL", () => {
    // **The reported bug.** `getAdapterProfile` answers "which code would handle this", and for any
    // live source it answers `builtin-live` / `enabled` — including one addressed `./FM.json`.
    // Gating testability on that alone made such a row offer a 测试 button and a 启用 switch, and
    // then the test returned `blocked` and the status column read 未执行: an address that cannot be
    // requested, presented as a source merely not yet tried.
    //
    // Measured against the author's real database, all 19 sources in that state were live entries
    // with a relative or bare address. They are 无法适配, which is what the parser already called
    // them and what the user asked for: not a pending source, an unavailable one.
    for (const api of [
      "./FM.json",
      "./lib/iptv.m3u",
      "../tv/thtv.txt",
      "yqk",
      "csp_MQiTV",
      "直播链接自定义",
      "proxy://wexian/1",
      "",
    ]) {
      const live = source({ sourceType: "live", capability: "needs-adapter", api });
      expect(isTestableLiveSource(live), api).toBe(false);
      expect(isTestableSource(live), api).toBe(false);
    }

    // And a fetchable address is still testable, so the guard does not refuse everything.
    expect(
      isTestableLiveSource(
        source({ sourceType: "live", api: "https://example.com/live.m3u" }),
      ),
    ).toBe(true);
    expect(
      isTestableLiveSource(source({ sourceType: "live", api: "http://a/tv.txt" })),
    ).toBe(true);
  });

  it("gives a non-fetchable live source a profile that is not runnable", () => {
    // **The registry is the single source of truth for "can this run", and it has to answer the
    // same way every reader asks.** The 状态 column falls back to this `execution` for an untestable
    // source, and the adapter tab counts by it. While the live branch answered `builtin-live`
    // unconditionally, a row addressed `./FM.json` rendered 可执行 in the 状态 column directly
    // beside 没有可用适配器 in the 适配器 column — one row making two opposite claims, which is the
    // exact contradiction this project has fixed before.
    const broken = getAdapterProfile(
      source({ sourceType: "live", api: "./FM.json", capability: "needs-adapter" }),
    );
    expect(broken.execution).not.toBe("enabled");
    expect(broken.id).toBe("private-protocol");
    // Its reason is the parser's own note for this state, so the row and the adapter tab agree.
    expect(broken.reason).toContain("需要单独适配器");

    // A fetchable live address still gets the live adapter.
    const ok = getAdapterProfile(
      source({ sourceType: "live", api: "https://example.com/live.m3u" }),
    );
    expect(ok.id).toBe("builtin-live");
    expect(ok.execution).toBe("enabled");
  });

  it("agrees with the Rust predicate about what a live loader can fetch", () => {
    // Mirrors `is_fetchable_live_url` in `src-tauri/src/adapters.rs`. The two must agree: this one
    // decides whether a row offers a test, and that one decides whether the test can run at all.
    expect(isFetchableLiveUrl("https://example.com/a.m3u")).toBe(true);
    expect(isFetchableLiveUrl("http://example.com/a.txt")).toBe(true);
    expect(isFetchableLiveUrl("HTTPS://EXAMPLE.COM/A.M3U")).toBe(true);
    for (const api of ["./FM.json", "/abs/path.m3u", "yqk", "proxy://x", "file:///c:/a.txt", "   "]) {
      expect(isFetchableLiveUrl(api), api).toBe(false);
    }
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
