import { describe, expect, it } from "vitest";

import {
  adapterRegistry,
  adapterStatusLabel,
  getAdapterProfile,
  isFetchableLiveUrl,
  isMovieLibrarySource,
  isPermanentlyUnsupported,
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
    // They used to be reported as named families — `drpy-js`, `remote-jar` — with a 已阻止 badge.
    // The refusal stands and is what these assertions are about; the names are what the user asked
    // to be rid of, because a name for another client's plugin tells the reader nothing.
    expect(
      getAdapterProfile(
        source({
          key: "drpy_js_demo",
          sourceType: "parser",
          capability: "blocked",
        }),
      ).execution,
    ).toBe("needs-adapter");
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
    ).toBe("private-protocol");
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

  it("gives a legacy parser-typed record no adapter, because Rust refuses it too", () => {
    // **The `http-parser` row is gone, and this is the test that would have caught it lying.**
    // Its only branch was gated on `sourceType === "parser"`, a value nothing has produced since
    // `da8f565` replaced `capability === "supported" ? "cms" : "parser"` with a hard-coded `"cms"`.
    // The row claimed `enabled` with three operations while `SiteAdapterKind::from_source` in Rust
    // has no parser kind at all and answered `Unsupported` — a source the interface offered to run
    // and the backend refused.
    //
    // The parse-service feature it was named after is untouched by this and very much alive: the
    // author's configuration carries 130 resolver services, they live in `normalizedConfig.parses`,
    // and they reach Rust through `resolve_playback`. `PlaybackResolution.adapter_id` in
    // `resolver.rs` still says "http-parser" — a *playback* label in a different namespace that
    // never consults this registry.
    const legacy = source({
      sourceType: "parser",
      key: "parse-post",
      api: "https://parser.example/resolve",
    });
    expect(getAdapterProfile(legacy).id).toBe("unknown");
    expect(getAdapterProfile(legacy).execution).toBe("needs-adapter");

    // A CatVod JS source has no adapter that can run it either: the script runtime and its archives
    // were removed, and the family needs remote code this app will not execute. It reads 无法适配
    // and is removed from the configuration outright.
    const kitty = source({
      key: "kitty-js",
      siteProtocol: "js-extension",
      capability: "blocked",
    });
    expect(getAdapterProfile(kitty).execution).toBe("needs-adapter");
    expect(isPermanentlyUnsupported(kitty)).toBe(true);
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

  it("gives a CatVod JS source no adapter at all, rather than one named after it", () => {
    // There were two mistakes in a row here. The first was promising that binding a local script
    // archive would make one of these run; that feature is gone, so the sentence named a switch that
    // does not exist. The second was answering with a profile called `js-extension`, which names the
    // format rather than the fact — and it is a fact about another client, not about what the reader
    // can do. What is left is the one answer that helps: no adapter can run this.
    const profile = getAdapterProfile(
      source({ key: "kitty", siteProtocol: "js-extension", capability: "blocked" }),
    );

    expect(profile.id).toBe("private-protocol");
    expect(profile.execution).toBe("needs-adapter");
    expect(profile.reason).not.toContain("绑定");
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
  });

  it("lists only adapters that can actually run, one row per real code path", () => {
    // **The user's decision, twice over.** First the five blocked families went — drpy-js,
    // csp-appmao, remote-jar, spider-runtime, js-extension — each named after another client's
    // plugin. Then `http-parser`, which nothing could ever assign, and the two extra rows standing
    // for `csp_Panda`/`csp_XYQHiker`, which are the same adapter as `xbpq` in the runtime.
    //
    // The table is what the 适配器 tab renders, so an entry here is a promise that code exists.
    for (const profile of adapterRegistry) {
      expect(profile.execution, profile.id).toBe("enabled");
      expect(profile.operations.length, profile.id).toBeGreaterThan(0);
    }
    const ids = adapterRegistry.map((profile) => profile.id);
    for (const gone of [
      "drpy-js",
      "csp-appmao",
      "remote-jar",
      "spider-runtime",
      "js-extension",
      // The parser feature is alive, but it is not an adapter: it works through
      // `normalizedConfig.parses` and `resolve_playback`, never through this registry.
      "http-parser",
      // Folded into `xbpq`, which is what they already were in Rust.
      "csp-panda",
      "csp-xyqhiker",
    ]) {
      expect(ids, gone).not.toContain(gone);
    }
    // Every source the app can run maps to one of these rows, so no row is decorative.
    const runnable = [
      source({ api: "https://cms.example/api" }),
      source({ sourceType: "live", api: "https://live.example/tv.m3u" }),
      source({ siteProtocol: "http-extension", api: "https://ext.example/api" }),
      source({ siteProtocol: "html-http", api: "https://html.example/list" }),
      source({ key: "fok", api: "csp_XBPQ" }),
    ];
    for (const item of runnable) {
      const profile = getAdapterProfile(item);
      expect(ids, profile.id).toContain(profile.id);
      expect(profile.execution, profile.id).toBe("enabled");
    }
  });

  it("keeps every declarative spelling, including the two that fold into xbpq", () => {
    // **This is the dangerous one.** `csp_XBPQ`, `csp_Panda` and `csp_XYQHiker` are one adapter with
    // three names — Rust puts all three markers into a single `ScriptFamily::Declarative` and runs
    // them through one module — so the registry reports one row and this function answers `xbpq` for
    // all three.
    //
    // The tokens must nevertheless stay recognisable, because this is also what tells
    // `isRemoteCodeFamily` that a `csp_`-prefixed source is not remote code — and that answer decides
    // whether the entry is DELETED from the user's configuration file. Dropping the `panda` or
    // `xyqhiker` token rather than folding it would make every such source look like an encrypted
    // AppMao payload and remove it on the next import or launch.
    for (const api of ["csp_XBPQ", "csp_Panda", "csp_XYQHiker"]) {
      const declarative: Partial<SourceRecord> = {
        key: "fok",
        api,
        siteProtocol: "spider",
        jar: "https://example.com/1.jar",
      };
      expect(isPermanentlyUnsupported(declarative), api).toBe(false);
      expect(getAdapterProfile(source(declarative)).id, api).toBe("xbpq");
      expect(getAdapterProfile(source(declarative)).execution, api).toBe("enabled");
    }
  });

  it("still refuses an unknown csp_ family, so folding did not become a way in", () => {
    // Being unable to read a payload is a reason to leave it alone, not a reason to run it. Only the
    // three spellings Moseek actually implements are exempted.
    for (const api of ["csp_Bili", "csp_SomeRuntime"]) {
      const unknown: Partial<SourceRecord> = { key: "x", api };
      expect(isPermanentlyUnsupported(unknown), api).toBe(true);
      expect(getAdapterProfile(source(unknown)).id, api).toBe("private-protocol");
    }
  });

  it("still refuses every family that would have to execute something", () => {
    // Removing the vocabulary must not remove the refusal. These sources are removed from the
    // configuration by `pruneUnsupportedEntries`, which reads `isPermanentlyUnsupported`; the
    // profile they get until then says they cannot be adapted.
    const refused: Partial<SourceRecord>[] = [
      { key: "drpy-one", siteProtocol: "spider" },
      { key: "南坊", api: "csp_AppMao", siteProtocol: "spider" },
      { key: "kitty", siteProtocol: "js-extension" },
      // A bare `type: 3` spider whose only hint is the JAR it wants to download. This one is the
      // reason the refusal cannot be a name list: nothing in key or api identifies it.
      { key: "tv-box-spider", siteProtocol: "spider", jar: "https://example.com/1.jar" },
    ];
    for (const overrides of refused) {
      const profile = getAdapterProfile(source(overrides));
      expect(profile.execution, overrides.key).toBe("needs-adapter");
      expect(isPermanentlyUnsupported({
        key: overrides.key,
        api: overrides.api,
        jar: overrides.jar,
        siteProtocol: overrides.siteProtocol,
      }), overrides.key).toBe(true);
    }
  });

  it("keeps a declarative source that looks like a spider", () => {
    // **The trap this predicate has to avoid.** An XBPQ source is `type: 3` and usually ships a JAR,
    // so every raw marker says "spider" while its configuration is a declarative vocabulary Moseek
    // reads today. Measured on the author's database, 60 working sources look exactly like this, and
    // a check reading only the markers would delete them from the user's file.
    const fromName: Partial<SourceRecord> = {
      key: "fok",
      api: "csp_XBPQ",
      siteProtocol: "spider",
    };
    expect(isPermanentlyUnsupported(fromName)).toBe(false);
    expect(getAdapterProfile(source(fromName)).id).toBe("xbpq");

    // The other shape: the parser recognised the vocabulary from `ext` alone, so neither the key nor
    // the api names the family. `siteProtocol` is then the only evidence, and it has to win.
    const fromVocabulary: Partial<SourceRecord> = {
      key: "奈飞中文",
      api: "https://example.com/api",
      siteProtocol: "xbpq",
      siteType: 3,
      jar: "https://example.com/1.jar",
    };
    expect(isPermanentlyUnsupported(fromVocabulary)).toBe(false);
    expect(getAdapterProfile(source(fromVocabulary)).id).toBe("xbpq");
  });

  it("lets remote code win when one name carries both markers", () => {
    // **Order is a contract, not an implementation detail.** TVBox lets a packager write both
    // markers on one source, and what such a source needs is the engine — the engine is what runs,
    // and the declarative payload is merely what it is pointed at. Rust reads the same two markers
    // in the same order (`script_family` tests drpy first), so the two sides agree about which
    // sources are removed from the user's file.
    expect(
      isPermanentlyUnsupported({ key: "drpy_xbpq", api: "csp_XBPQ" }),
    ).toBe(true);
    // And the ordinary declarative source is still kept, so the ordering does not swallow it.
    expect(isPermanentlyUnsupported({ key: "fok", api: "csp_XBPQ" })).toBe(false);
  });

  it("never treats an unfetchable live address as permanently unsupported", () => {
    // A relative path or a bare token is repaired against the document's base URL, so it is not a
    // verdict — pruning on it would race the repair and delete sources that are about to work.
    for (const api of ["./FM.json", "yqk", "csp_MQiTV", "直播链接自定义"]) {
      expect(
        isPermanentlyUnsupported({ key: "live-1", api, isLive: true }),
        api,
      ).toBe(false);
    }
    // A scheme that must never be fetched is a different matter.
    expect(
      isPermanentlyUnsupported({ key: "live-1", api: "javascript:1", isLive: true }),
    ).toBe(true);
  });

  it("no longer explains itself by naming a runtime it does not have", () => {
    // Three successive versions of the drpy entry were wrong in three different ways, and the last
    // one is why the entry is gone. It first said 未提供 JS 沙箱 — false, a sandbox existed and was
    // never the obstacle. It then named the host APIs actually required — true, and useless, because
    // it described a runtime nobody was going to build. The user's verdict was that recognising
    // these sources does not help anybody, so the family is no longer named at all: the entry is
    // removed from the configuration at import and the profile that would have described it says
    // only that it cannot be adapted.
    const drpy = getAdapterProfile(
      source({ key: "drpy-one", api: "https://example.com/lib/drpy2.min.js" }),
    );

    expect(drpy.id).toBe("private-protocol");
    expect(drpy.reason).not.toContain("沙箱");
    expect(drpy.reason).not.toContain("宿主 API");
    // What it does say is the state the reader can act on.
    expect(drpy.execution).toBe("needs-adapter");
    expect(isPermanentlyUnsupported({ key: "drpy-one", api: "https://x/lib/drpy2.min.js" }))
      .toBe(true);
  });
});
