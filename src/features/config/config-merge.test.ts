import { describe, expect, it } from "vitest";

import {
  absolutizeRelativeSites,
  carryLocalSourceState,
  mergeRawConfigs,
  mergeSourceLists,
  rawSiteIdentity,
  sourceIdentity,
  stableStringify,
} from "@/features/config/config-merge";
import { parseConfigText } from "@/features/config/config-parser";

const site = (over: Record<string, unknown> = {}) => ({
  key: "k",
  name: "n",
  type: 1,
  api: "https://a.example/api.php/provide/vod",
  ...over,
});

describe("source identity", () => {
  it("treats the same site under two different keys as one source", () => {
    // This is the case the whole feature exists for: the same site arrives from two configurations
    // under different keys, and the user should end up with one row, not two.
    const a = rawSiteIdentity(site({ key: "hnzy", name: "红牛" }));
    const b = rawSiteIdentity(site({ key: "红牛资源", name: "红牛资源(切)" }));
    expect(a).toBe(b);
  });

  it("keeps two different sites that share a key", () => {
    // `key` is not an identity. In the author's own configurations `Bili` is `csp_Bili` in one and a
    // different `...Guard` address in another; deduping on key would silently delete one of them.
    const a = rawSiteIdentity(site({ key: "Bili", api: "csp_Bili" }));
    const b = rawSiteIdentity(
      site({ key: "Bili", api: "https://szyyds.cn/tv/csp_BiliGuard" }),
    );
    expect(a).not.toBe(b);
  });

  it("keeps two different sites that share an api", () => {
    // `csp_XBPQ` is shared by 58 distinct sites in the author's configurations, each distinguished
    // by its ext. Deduping on api alone would collapse all of them into one.
    const a = rawSiteIdentity(site({ api: "csp_XBPQ", ext: "http://x/七新影视.json" }));
    const b = rawSiteIdentity(site({ api: "csp_XBPQ", ext: "http://y/nk.json" }));
    expect(a).not.toBe(b);
  });

  it("keeps two different sources that share an api, in the snapshot identity too", () => {
    // `sourceIdentity` is the one the migration matches stored snapshots with, and it needs the
    // same protection as the raw identity: `csp_XBPQ` alone is 58 distinct sources in the author's
    // configurations, distinguished only by their ext.
    const a = sourceIdentity({ api: "csp_XBPQ", ext: "http://x/七新影视.json" });
    const b = sourceIdentity({ api: "csp_XBPQ", ext: "http://y/nk.json" });
    expect(a).not.toBe(b);
    // And the same site under two labels is one source.
    expect(sourceIdentity({ api: "https://a/v", ext: "E" })).toBe(
      sourceIdentity({ api: "https://a/v/", ext: "E" }),
    );
  });

  it("treats an object ext and its reordered twin as the same", () => {
    // `ext` is an object for some dialects, and JSON key order is not meaningful.
    const a = rawSiteIdentity(site({ ext: { b: 1, a: 2 } }));
    const b = rawSiteIdentity(site({ ext: { a: 2, b: 1 } }));
    expect(a).toBe(b);
  });

  it("ignores a trailing slash and letter case in the api", () => {
    const a = rawSiteIdentity(site({ api: "https://A.example/api.php/provide/vod/" }));
    const b = rawSiteIdentity(site({ api: "https://a.example/api.php/provide/vod" }));
    expect(a).toBe(b);
  });

  it("treats an absent type as the default it means", () => {
    // TVBox reads a site with no `type` as a type-1 JSON source, and the parser agrees. Comparing
    // "" against "1" would call the same site two different ones whenever one configuration stated
    // the default and the other left it out.
    const stated = rawSiteIdentity(site({ type: 1 }));
    const omitted = rawSiteIdentity({ key: "k", name: "n", api: site().api });
    expect(stated).toBe(omitted);
  });

  it("accepts a numeric type given as a string", () => {
    // Published configurations write `"type": "3"` as often as `3`.
    expect(rawSiteIdentity(site({ type: "3" }))).toBe(
      rawSiteIdentity(site({ type: 3 })),
    );
  });
});

describe("merging raw configurations", () => {
  it("unions sites and reports what it did", () => {
    const existing = { sites: [site({ key: "a" }), site({ key: "b", api: "https://b.example/v" })] };
    const incoming = {
      // The same site as "b" but labelled differently, which is exactly the duplicate the user
      // wants collapsed: same type, api and ext.
      sites: [
        site({ key: "b2", api: "https://b.example/v" }),
        site({ key: "c", api: "https://c.example/v" }),
      ],
    };

    const { raw, report } = mergeRawConfigs(existing, incoming);

    expect(raw.sites).toHaveLength(3);
    // It matched on identity and the only difference was the label, so the incoming definition wins.
    expect(report.sites).toEqual({ added: 1, updated: 1, unchanged: 0 });
  });

  it("takes the incoming definition when a source changed", () => {
    const existing = { sites: [site({ key: "a", name: "旧名字" })] };
    const incoming = { sites: [site({ key: "a", name: "新名字" })] };

    const { raw, report } = mergeRawConfigs(existing, incoming);

    expect(report.sites).toEqual({ added: 0, updated: 1, unchanged: 0 });
    expect((raw.sites as Record<string, unknown>[])[0].name).toBe("新名字");
  });

  it("keeps the existing order so importing does not reshuffle the list", () => {
    const existing = { sites: [site({ key: "a" }), site({ key: "b", api: "https://b/v" })] };
    const incoming = { sites: [site({ key: "b", api: "https://b/v" }), site({ key: "z", api: "https://z/v" })] };

    const { raw } = mergeRawConfigs(existing, incoming);
    const keys = (raw.sites as Record<string, unknown>[]).map((s) => s.key);
    expect(keys).toEqual(["a", "b", "z"]);
  });

  it("preserves fields the parsed model does not carry", () => {
    // 192 field instances in the author's real configurations exist only in the raw text. A merge
    // that regenerated the file from parsed sources would silently drop every one of them.
    const existing = {
      sites: [site({ changeable: 1, timeout: 10, categories: ["a", "b"], header: { ua: "x" } })],
    };
    const incoming = { sites: [site({ key: "other", api: "https://other/v", playUrl: "p" })] };

    const { raw } = mergeRawConfigs(existing, incoming);
    const kept = (raw.sites as Record<string, unknown>[])[0];
    expect(kept.changeable).toBe(1);
    expect(kept.timeout).toBe(10);
    expect(kept.categories).toEqual(["a", "b"]);
    expect(kept.header).toEqual({ ua: "x" });
  });

  it("keeps collections that only one side has", () => {
    // Dropping a collection the other configuration happens not to use would delete real settings.
    const existing = { sites: [], ads: ["a.example"], ijk: [{ group: "硬解码" }] };
    const incoming = { sites: [], flags: ["youku"], doh: [{ name: "Google" }] };

    const { raw, report } = mergeRawConfigs(existing, incoming);

    expect(raw.ads).toEqual(["a.example"]);
    expect(raw.ijk).toEqual([{ group: "硬解码" }]);
    expect(raw.flags).toEqual(["youku"]);
    expect(report.collectionsIntroduced).toContain("flags");
    expect(report.collectionsIntroduced).toContain("doh");
  });

  it("unions lives by name and url", () => {
    const existing = { lives: [{ name: "直播", url: "http://a/tv.txt" }] };
    const incoming = {
      lives: [{ name: "直播", url: "http://a/tv.txt" }, { name: "咪咕", url: "http://b/tv.txt" }],
    };

    const { raw, report } = mergeRawConfigs(existing, incoming);
    expect(raw.lives).toHaveLength(2);
    expect(report.lives.added).toBe(1);
  });

  it("dedupes parses by name, url and type", () => {
    const existing = { parses: [{ name: "Json聚合", type: 3, url: "Demo" }] };
    const incoming = {
      parses: [{ name: "Json聚合", type: 3, url: "Demo" }, { name: "聚合1", type: 3, url: "Demo" }],
    };

    const { raw, report } = mergeRawConfigs(existing, incoming);
    expect(raw.parses).toHaveLength(2);
    expect(report.unchanged).toBe(1);
    expect(report.added).toBe(1);
  });

  it("lets the incoming configuration state a scalar, but not blank one out", () => {
    const existing = { wallpaper: "https://old/", warningText: "请勿付费" };

    const stated = mergeRawConfigs(existing, { wallpaper: "https://new/" });
    expect(stated.raw.wallpaper).toBe("https://new/");
    // The incoming file said nothing about warningText, so the existing one stands.
    expect(stated.raw.warningText).toBe("请勿付费");

    const blanked = mergeRawConfigs(existing, { wallpaper: "" });
    expect(blanked.raw.wallpaper).toBe("https://old/");
  });

  it("is idempotent: importing the same configuration twice changes nothing", () => {
    // A merge the user can safely repeat is the whole point of "import freely".
    const existing = { sites: [site({ key: "a" }), site({ key: "b", api: "https://b/v" })], ads: ["x"] };
    const incoming = { sites: [site({ key: "a2" }), site({ key: "c", api: "https://c/v" })], ads: ["y"] };

    const once = mergeRawConfigs(existing, incoming);
    const twice = mergeRawConfigs(once.raw, incoming);

    expect(stableStringify(twice.raw)).toBe(stableStringify(once.raw));
    expect(twice.report.sites).toEqual({ added: 0, updated: 0, unchanged: 2 });
    expect(twice.report.added).toBe(0);
  });

  it("does not mutate either input", () => {
    const existing = { sites: [site({ key: "a" })] };
    const incoming = { sites: [site({ key: "b", api: "https://b/v" })] };
    const existingCopy = stableStringify(existing);
    const incomingCopy = stableStringify(incoming);

    mergeRawConfigs(existing, incoming);

    expect(stableStringify(existing)).toBe(existingCopy);
    expect(stableStringify(incoming)).toBe(incomingCopy);
  });
});

describe("absolutising relative references", () => {
  it("resolves a relative api against the incoming base url", () => {
    // A merged configuration can only keep one base URL, so a relative path left as-is would point
    // at the wrong host once another configuration's base is in effect.
    const raw = { sites: [site({ api: "./libs/js/drpy2.min.js", ext: "./libs/js/x.js" })] };
    const resolved = absolutizeRelativeSites(raw, "https://szyyds.cn/tv/x.json");
    const site0 = (resolved.sites as Record<string, unknown>[])[0];
    expect(site0.api).toBe("https://szyyds.cn/tv/libs/js/drpy2.min.js");
    expect(site0.ext).toBe("https://szyyds.cn/tv/libs/js/x.js");
  });

  it("leaves absolute urls and dialect tokens alone", () => {
    const raw = {
      sites: [
        site({ api: "https://a/v" }),
        site({ key: "csp", api: "csp_Bili", ext: "https://a/e" }),
      ],
    };
    const resolved = absolutizeRelativeSites(raw, "https://base/");
    const sites = resolved.sites as Record<string, unknown>[];
    expect(sites[0].api).toBe("https://a/v");
    expect(sites[1].api).toBe("csp_Bili");
  });

  it("returns the input unchanged when there is no usable base url", () => {
    const raw = { sites: [site({ api: "./libs/x.js" })] };
    expect(absolutizeRelativeSites(raw, null)).toBe(raw);
    expect(absolutizeRelativeSites(raw, "not a url")).toBe(raw);
  });
});

/** A source snapshot as the merge sees it: the identity fields plus whatever local state it holds. */
type TestSource = {
  api: string;
  /** Optional: the parser's own `SourceRecord` omits it, and a test may merge real parsed sources. */
  ext?: unknown;
  capability: string;
  enabled: boolean;
  testStatus: string;
  [field: string]: unknown;
};

describe("merging source lists", () => {
  const src = (over: Record<string, unknown> = {}): TestSource => ({
    api: "https://a/v",
    ext: "E",
    capability: "supported",
    enabled: true,
    testStatus: "untested",
    ...over,
  });

  it("matches a snapshot written by an older parser", () => {
    // Stored snapshots call every source "parser"; the current parser calls the same source "cms".
    // Including sourceType in the identity made every existing snapshot unmatchable, which silently
    // discarded the user's switches and test results on the first import after upgrading.
    const stored = src({ sourceType: "parser", enabled: false, testStatus: "failed" });
    const incoming = src({ sourceType: "cms" });

    const result = mergeSourceLists([stored], [incoming]);

    expect(result.added).toBe(0);
    expect(result.sources).toHaveLength(1);
    // The user's own state survived, even though the parser's label for the kind changed.
    expect(result.sources[0].enabled).toBe(false);
    expect(result.sources[0].testStatus).toBe("failed");
  });

  it("keeps a source's position and takes the incoming definition", () => {
    const existing = [src({ key: "old", name: "旧" }), src({ key: "b", api: "https://b/v" })];
    const incoming = [src({ key: "new", name: "新" })];

    const result = mergeSourceLists(existing, incoming);

    expect(result.updated).toBe(1);
    expect(result.sources[0].key).toBe("new");
    expect(result.sources[1].api).toBe("https://b/v");
  });

  it("appends a source that is genuinely new", () => {
    const result = mergeSourceLists([src()], [src({ api: "https://b/v" })]);
    expect(result.added).toBe(1);
    expect(result.sources).toHaveLength(2);
  });

  it("switches off a source the new configuration no longer supports", () => {
    const result = mergeSourceLists(
      [src({ enabled: true })],
      [src({ capability: "blocked" })],
    );
    expect(result.sources[0].enabled).toBe(false);
  });

  it("does not mutate either list", () => {
    const existing = [src()];
    const incoming = [src({ name: "新" })];
    const before = stableStringify(existing);
    mergeSourceLists(existing, incoming);
    expect(stableStringify(existing)).toBe(before);
    expect(stableStringify(incoming)).toBe(stableStringify([src({ name: "新" })]));
  });

  it("keeps two entries from the SAME list that share an identity", () => {
    // The author's own 配置 2 holds four pairs like this (米搜 / 米搜-2, Aid / Aid-2,
    // xgapp / 骑骑影院, MV_vod / MV_vod-2). Merging that document appended the first and then
    // matched the second against it, overwriting it — one entry vanished, which is what "少了一些
    // 内容" was. Two entries in one list are two entries the user can see.
    const incoming = [
      src({ key: "米搜", name: "米盘搜搜", api: "csp_MIPanSo", ext: '{"a":1}' }),
      src({ key: "米搜-2", name: "米搜搜索", api: "csp_MIPanSo", ext: '{"a":1}' }),
    ];

    const result = mergeSourceLists([src({ key: "other", api: "https://other/v" })], incoming);

    expect(result.sources).toHaveLength(3);
    expect(result.sources.map((s) => s.key)).toEqual(["other", "米搜", "米搜-2"]);
  });

  it("emits unique keys so the loader has nothing to rename", () => {
    // The merge matches on identity, not on key, so a merged list can hold several entries sharing
    // a display key (`Bili` appears three times across the author's configurations). The Rust
    // loader renames duplicates on every read, which made the key the user saw change each time
    // the page opened — the "内容都会变" report.
    const existing = [src({ key: "Bili", api: "csp_Bili", ext: "a" })];
    const incoming = [
      src({ key: "Bili", api: "csp_Bili", ext: "b" }),
      src({ key: "Bili", api: "csp_Bili", ext: "c" }),
    ];

    const result = mergeSourceLists(existing, incoming);

    const keys = result.sources.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["Bili", "Bili-2", "Bili-3"]);
  });

  it("leaves an entry that declares no key without one", () => {
    // A generated key is not merely bookkeeping for these entries. `classifySource` requires a raw
    // `key` for a site, so writing one in upgrades a source the parser refuses (`invalid`, never
    // run) into one it will run (`supported`) — importing a configuration would make a source
    // executable that Moseek had judged unusable. It also desynchronises the two key namespaces:
    // the parser numbers such an entry by position (`live-2`) while a blank key becomes `-2`.
    const merged = mergeRawConfigs(
      {},
      {
        sites: [{ name: "无键", api: "https://example.com/api" }],
        lives: [
          { name: "直播一", url: "https://l.example/1.txt" },
          { name: "直播二", url: "https://l.example/2.txt" },
        ],
      },
    );

    const site = (merged.raw.sites as { key?: unknown }[])[0];
    expect(site.key).toBeUndefined();

    const liveKeys = (merged.raw.lives as { key?: unknown }[]).map((live) => live.key);
    expect(liveKeys).toEqual([undefined, undefined]);
  });

  it("does not change a source's capability by giving it a key", () => {
    // The consequence that matters, measured through the parser exactly as an import experiences it.
    // TWO keyless sites, because the upgrade happens on the entry that collides: the first stays
    // keyless only if nothing writes a key at all, while the second is the one a generated key would
    // hand `supported` to.
    const raw = {
      sites: [
        { name: "无键一", api: "https://a.example/api" },
        { name: "无键二", api: "https://b.example/api" },
      ],
      lives: [],
    };

    const parsed = parseConfigText(JSON.stringify(raw), undefined);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const before = parsed.sources.map((source) => source.capability);
    expect(before).toEqual(["invalid", "invalid"]);

    const merged = mergeRawConfigs({}, raw);
    const after = parseConfigText(JSON.stringify(merged.raw), undefined);
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    expect(after.sources.map((source) => source.capability)).toEqual(before);
  });

  it("still gives a key to an entry that has one, so collisions stay resolved", () => {
    // The guard above must not switch off the de-duplication it sits next to.
    const merged = mergeRawConfigs(
      {},
      {
        sites: [
          { key: "k", api: "https://a.example/api" },
          { key: "k", api: "https://b.example/api" },
        ],
        lives: [],
      },
    );

    expect((merged.raw.sites as { key?: unknown }[]).map((site) => site.key)).toEqual([
      "k",
      "k-2",
    ]);
  });

  it("is stable when the same merge is applied twice", () => {
    // The merged list is written back and merged again on the next import, so it has to be a fixed
    // point: a second pass must change nothing, keys included.
    const existing = [src({ key: "Bili", api: "csp_Bili", ext: "a" })];
    const incoming = [
      src({ key: "Bili", api: "csp_Bili", ext: "b" }),
      src({ key: "other", api: "https://other/v" }),
    ];

    const once = mergeSourceLists(existing, incoming);
    const twice = mergeSourceLists(once.sources, incoming);

    expect(twice.added).toBe(0);
    expect(twice.sources.map((s) => s.key)).toEqual(once.sources.map((s) => s.key));
  });

  it("treats an ext object and its JSON-encoded twin as the same source", () => {
    // A configuration writes `ext` as an object; the parser stores it as a string. Without this the
    // raw text and the source list report the same site under two identities, so the two halves of
    // a stored document drift apart (8 mismatches in the author's database).
    //
    // The string form here is deliberately NOT in canonical order and carries extra whitespace, so
    // a plain string comparison cannot pass by coincidence — an earlier version of this test used a
    // canonical string and stayed green even with the normalisation removed.
    const asObject = sourceIdentity({ api: "csp_WoGG", ext: { "Cloud-drive": "x.txt" } });
    const asString = sourceIdentity({
      api: "csp_WoGG",
      ext: '{ "Cloud-drive" : "x.txt" }',
    });
    expect(asString).toBe(asObject);
  });

  it("still treats genuinely different ext objects as different", () => {
    const a = sourceIdentity({ api: "csp_WoGG", ext: { "Cloud-drive": "a.txt" } });
    const b = sourceIdentity({ api: "csp_WoGG", ext: { "Cloud-drive": "b.txt" } });
    expect(a).not.toBe(b);
  });
});

describe("carrying local source state", () => {
  const parsed = (over: Record<string, unknown> = {}): TestSource => ({
    api: "https://a/v",
    ext: "E",
    capability: "supported",
    enabled: true,
    testStatus: "untested",
    ...over,
  });

  it("keeps the user's switch and test result across an import", () => {
    const previous = [
      parsed({ enabled: false, testStatus: "failed", testItemCount: 3, testedAt: "昨天" }),
    ];
    const incoming = [parsed({ name: "新定义" })];

    const { sources, carried } = carryLocalSourceState(incoming, previous);

    expect(carried).toBe(1);
    expect(sources[0].enabled).toBe(false);
    expect(sources[0].testStatus).toBe("failed");
    expect(sources[0].testItemCount).toBe(3);
    expect(sources[0].testedAt).toBe("昨天");
    // The definition itself comes from the imported configuration.
    expect((sources[0] as Record<string, unknown>).name).toBe("新定义");
  });

  it("keeps the switch through mergeSourceLists, which is what an import actually uses", () => {
    // `carryLocalSourceState` and `mergeSourceLists` both preserve local state, and the import path
    // goes through the latter. Pinning only the former let a mutation that stopped
    // `mergeSourceLists` carrying anything go unnoticed, because the other test still passed.
    const existing = [
      parsed({ enabled: false, testStatus: "failed", testItemCount: 7, testedAt: "前天" }),
    ];
    const incoming = [parsed({ name: "新定义" })];

    const result = mergeSourceLists(existing, incoming);

    expect(result.added).toBe(0);
    expect(result.sources[0].enabled).toBe(false);
    expect(result.sources[0].testStatus).toBe("failed");
    expect(result.sources[0].testItemCount).toBe(7);
    expect(result.sources[0].testedAt).toBe("前天");
    expect((result.sources[0] as Record<string, unknown>).name).toBe("新定义");
  });

  it("refuses to keep a source switched on once it is no longer supported", () => {
    // `enabled` means "safe to use" everywhere else in the app, so a source the new configuration
    // downgraded must not stay on.
    const previous = [parsed({ enabled: true })];
    const incoming = [parsed({ capability: "blocked" })];

    const { sources } = carryLocalSourceState(incoming, previous);
    expect(sources[0].enabled).toBe(false);
  });

  it("leaves a genuinely new source at its parsed defaults", () => {
    const { sources, carried } = carryLocalSourceState([parsed()], []);
    expect(carried).toBe(0);
    expect(sources[0].enabled).toBe(true);
  });

  it("does not duplicate a recovered live source whose raw text spells the old address", () => {
    // Found in a real browser, not by these tests: `replace_known_live_source_urls` repairs a live
    // source to a working absolute URL while the raw text keeps the old relative spelling. Saving
    // re-parses that text against the base URL, so the entry resolves to a DIFFERENT address and the
    // identity lookup finds nothing — the source is added a second time. Measured, one unrelated
    // field edit took the list from 26 to 29 with SAO0 and IPV6 each appearing twice.
    const raw = JSON.stringify({
      lives: [{ key: "-4", name: "SAO0", url: "./libs/tv/tvlive.txt" }],
    });
    const parsedConfig = parseConfigText(raw, "https://szyyds.cn/tv/x.json");
    expect(parsedConfig.ok).toBe(true);
    if (!parsedConfig.ok) return;

    // Typed as the parser's own record, so the two sides of the merge are the same shape — the
    // stored list and the parsed list are both `SourceRecord` in the app, and typing them
    // differently here would let a real mismatch through.
    const existing: typeof parsedConfig.sources = [
      {
        ...parsedConfig.sources[0],
        key: "live-2-2",
        name: "SAO0",
        api: "https://iptv-org.github.io/iptv/countries/cn.m3u",
      },
    ];

    const result = mergeSourceLists(existing, parsedConfig.sources);

    const copies = result.sources.filter((source) => source.name === "SAO0");
    expect(copies).toHaveLength(1);
    expect(result.added).toBe(0);
    // And the surviving copy keeps the RECOVERED address. Taking the incoming one would silently
    // undo the repair, turning a working URL back into a relative path.
    expect(copies[0].api).toBe("https://iptv-org.github.io/iptv/countries/cn.m3u");
  });

  it("keeps both sources when a name is ambiguous rather than collapsing one", () => {
    // The name fallback must not become a way to lose a source. Two live sources that share a name
    // and differ in address are two sources the user can see, so neither is claimed and both stay.
    const existing = [
      parsed({ key: "a", name: "同名", sourceType: "live", api: "https://one.example/tv.txt" }),
      parsed({ key: "b", name: "同名", sourceType: "live", api: "https://two.example/tv.txt" }),
    ];
    const incoming = [
      parsed({ key: "c", name: "同名", sourceType: "live", api: "https://three.example/tv.txt" }),
    ];

    const result = mergeSourceLists(existing, incoming);

    expect(result.sources.filter((source) => source.name === "同名")).toHaveLength(3);
    expect(result.added).toBe(1);
  });

  it("does not use the name fallback to collapse two differently-named live sources", () => {
    // The fallback is keyed on the name matching, so a different name is a different source and the
    // ordinary identity path applies: this one is genuinely new.
    const existing = [
      parsed({ key: "a", name: "甲", sourceType: "live", api: "https://one.example/tv.txt" }),
    ];
    const incoming = [
      parsed({ key: "b", name: "乙", sourceType: "live", api: "https://two.example/tv.txt" }),
    ];

    const result = mergeSourceLists(existing, incoming);

    expect(result.sources).toHaveLength(2);
    expect(result.added).toBe(1);
  });
});
