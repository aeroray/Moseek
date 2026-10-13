import { describe, expect, it } from "vitest";

import {
  buildImportPreview,
  keepSelectedEntries,
} from "@/features/config/config-import-preview";

/**
 * The dialog's list, and the filter that acts on it.
 *
 * **The reported problem.** The import dialog showed a JSON editor and a button reading 合并进中心配置.
 * The user's words: 「用户其实完全看不明白」— an editor offers no way to tell whether what is in it is any
 * good, and the commit button is a decision about a document they cannot evaluate. What they can evaluate
 * is a list of what the file contains, and whether to take all of it or some of it.
 */
const CONFIG = JSON.stringify({
  sites: [
    { key: "可用", name: "可用的源", api: "https://ok.example/api.php/provide/vod" },
    { key: "缺地址", name: "没有地址的源" },
  ],
  lives: [{ name: "直播源", url: "https://live.example/a.m3u" }],
  parses: [{ key: "解析甲", name: "解析甲", type: 1, url: "https://parse.example/?url=" }],
  // A field Moseek does not model, to prove a filtered import does not discard it.
  wallpapaer: "https://wallpaper.example/",
  doh: [{ name: "dns", url: "https://dns.example/dns-query" }],
});

describe("buildImportPreview", () => {
  it("lists every kind of resource the file carries", () => {
    const preview = buildImportPreview(CONFIG);

    expect(preview.ok).toBe(true);
    expect(preview.counts.total).toBe(4);
    expect(preview.candidates.filter((c) => c.kind === "site")).toHaveLength(2);
    expect(preview.candidates.filter((c) => c.kind === "live")).toHaveLength(1);
    expect(preview.candidates.filter((c) => c.kind === "parser")).toHaveLength(1);
  });

  it("names and addresses every entry, so the list is readable without the file", () => {
    const preview = buildImportPreview(CONFIG);
    const first = preview.candidates.find((c) => c.key === "可用");

    expect(first?.name).toBe("可用的源");
    expect(first?.address).toBe("https://ok.example/api.php/provide/vod");
  });

  it("marks an entry that cannot run, and says why, without hiding it", () => {
    // **Hiding it would make the import silently smaller than the file that was loaded** — the exact
    // complaint this page has already produced once. The entry is real; it just cannot run.
    //
    // It is listed but *unusable*, and the dialog keeps it unticked and disables its box: a switch that
    // can be turned on implies importing it would make it work.
    const preview = buildImportPreview(CONFIG);
    const broken = preview.candidates.find((c) => c.key === "缺地址");

    expect(broken).toBeDefined();
    expect(broken?.usable).toBe(false);
    expect(broken?.note).toBeTruthy();
    expect(preview.counts.unusable).toBe(1);
    expect(preview.counts.usable).toBe(3);
  });

  it("reports what the automatic pruning removed, before the user commits", () => {
    // Stated in the dialog rather than after the merge: the entry is absent from the list they are
    // about to confirm, and they can see that before pressing anything.
    const preview = buildImportPreview(
      JSON.stringify({
        sites: [
          { key: "好源", name: "好源", type: 1, api: "https://new.example/api.php/provide/vod" },
          { key: "drpy源", name: "drpy 源", api: "https://x.example/lib/drpy2.min.js" },
        ],
      }),
    );

    expect(preview.ok).toBe(true);
    expect(preview.repairNote).toContain("1");
    expect(preview.candidates.map((c) => c.key)).toEqual(["好源"]);
  });

  it("says what is wrong rather than showing an empty list", () => {
    const preview = buildImportPreview("{ sites: [ }");
    expect(preview.ok).toBe(false);
    expect(preview.error).toBeTruthy();
    expect(preview.candidates).toEqual([]);
  });

  it("distinguishes an empty input from an unreadable one", () => {
    // "Nothing loaded yet" and "this file is broken" need different words: the first is a prompt, the
    // second is a problem.
    const preview = buildImportPreview("   ");
    expect(preview.ok).toBe(false);
    expect(preview.error).toContain("还没有内容");
  });
});

/**
 * Repeats inside one file.
 *
 * **A repeat is not a second resource.** Importing it creates nothing — the merge collapses it into the
 * first — so the row exists only to explain why the count differs from the file's. Measured on the
 * user's own export: 185 entries of which 1 is a repeat, and the duplicates they expected in 解析服务
 * turned out not to be duplicates at all (see the last test here, which is the reason this is careful).
 */
describe("duplicate entries", () => {
  it("marks the later of two identical sites, keeping the first", () => {
    const preview = buildImportPreview(
      JSON.stringify({
        sites: [
          { key: "先", name: "极速｜资源", api: "https://jszyapi.com/api.php/provide/vod/" },
          { key: "后", name: "极速｜采集", api: "https://jszyapi.com/api.php/provide/vod/" },
        ],
      }),
    );

    const [first, second] = preview.candidates;
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(preview.counts.duplicate).toBe(1);
    expect(preview.counts.selectable).toBe(1);
  });

  it("ignores casing, padding and a trailing slash", () => {
    // The same address typed two ways is one address. `normalizeText` in the merge module already folds
    // these, and this reuses it rather than restating the rule.
    const preview = buildImportPreview(
      JSON.stringify({
        parses: [
          { key: "a", name: "甲", type: 1, url: "https://p.example/Jx?URL=" },
          { key: "b", name: "乙", type: 1, url: "  https://p.example/Jx?URL=  " },
        ],
      }),
    );

    expect(preview.candidates[1]?.duplicate).toBe(true);
  });

  it("keeps two sites that share an address but differ by ext", () => {
    // **The case that makes address-only comparison wrong.** A published configuration routes many
    // separate sites through one `csp_XBPQ` address and distinguishes them by `ext` — measured at 58
    // different sites on that single address. The user's own export has two, 欧洲 and 哆啦, pointing at
    // different provider sites; calling them duplicates would delete a working source.
    //
    // Asserted on `duplicate`, not on `selectable`: these fixtures use a placeholder host, so the parser
    // correctly refuses to call them runnable. Whether they RUN is a different question from whether
    // they are the same entry, and this test is about the second.
    const preview = buildImportPreview(
      JSON.stringify({
        sites: [
          {
            key: "csp_XBPQ_欧洲",
            name: "欧洲",
            api: "http://xmbjm.fh4u.org/csp_XBPQ",
            ext: { 主页url: "https://euvod.tv/" },
          },
          {
            key: "csp_XBPQ_哆啦",
            name: "哆啦",
            api: "http://xmbjm.fh4u.org/csp_XBPQ",
            ext: { 主页url: "https://dora.xiaoxinbk.com/" },
          },
        ],
      }),
    );

    expect(preview.candidates.every((c) => !c.duplicate)).toBe(true);
    expect(preview.counts.duplicate).toBe(0);
  });

  it("does not call two services duplicates just because they share a name", () => {
    // 解析服务 in the real file repeat names — 盘古 appears three times, 8090 three times — with different
    // addresses. A name is a label, not an identity, and hiding these would remove real services.
    const preview = buildImportPreview(
      JSON.stringify({
        parses: [
          { key: "p1", name: "盘古", type: 1, url: "https://a.example/?url=" },
          { key: "p2", name: "盘古", type: 1, url: "https://b.example/?url=" },
          { key: "p3", name: "盘古", type: 1, url: "https://c.example/?url=" },
        ],
      }),
    );

    expect(preview.counts.duplicate).toBe(0);
    expect(preview.counts.selectable).toBe(3);
  });

  it("does not compare across kinds", () => {
    // A site and a live entry can share an address without being the same resource: one is a catalogue
    // API, the other a playlist, and the merge keeps them in separate collections.
    const preview = buildImportPreview(
      JSON.stringify({
        sites: [{ key: "s", name: "站点", api: "https://same.example/list" }],
        lives: [{ key: "l", name: "直播", url: "https://same.example/list" }],
      }),
    );

    expect(preview.counts.duplicate).toBe(0);
  });

  it("leaves an entry with no address out of the comparison", () => {
    // Nothing to compare against, and marking it would remove a row the user cannot see a twin of.
    const preview = buildImportPreview(
      JSON.stringify({ sites: [{ key: "a", name: "无地址甲" }, { key: "b", name: "无地址乙" }] }),
    );

    expect(preview.counts.duplicate).toBe(0);
    // Both are unusable for a different reason, which is what the row says.
    expect(preview.counts.unusable).toBe(2);
  });
});

describe("keepSelectedEntries", () => {
  const preview = buildImportPreview(CONFIG);
  const idsOf = (...keys: string[]) =>
    new Set(
      preview.candidates.filter((c) => keys.includes(c.key)).map((c) => c.id),
    );

  it("returns the text untouched when everything is selected", () => {
    // Byte-identical, so an import that deselected nothing cannot reformat or reorder the file.
    const all = new Set(preview.candidates.map((c) => c.id));
    expect(keepSelectedEntries(preview.text, preview.candidates, all)).toBe(preview.text);
  });

  it("removes exactly the entries that were unticked", () => {
    const kept = keepSelectedEntries(preview.text, preview.candidates, idsOf("可用", "直播源"));
    const parsed = JSON.parse(kept) as { sites: { key: string }[]; lives: unknown[] };

    expect(parsed.sites.map((s) => s.key)).toEqual(["可用"]);
    expect(parsed.lives).toHaveLength(1);
  });

  it("does not discard the fields Moseek does not model", () => {
    // **The reason this works on the raw object rather than on the parsed entries.** `doh`, `ads`,
    // `rules`, a wallpaper, another client's own keys — regenerating the document from the entry model
    // would drop all of it silently.
    const kept = keepSelectedEntries(preview.text, preview.candidates, idsOf("可用"));
    const parsed = JSON.parse(kept) as Record<string, unknown>;

    expect(parsed.wallpapaer).toBe("https://wallpaper.example/");
    expect(parsed.doh).toHaveLength(1);
  });

  it("filters the parse services too, so unticking one means something", () => {
    const kept = keepSelectedEntries(preview.text, preview.candidates, idsOf("可用", "直播源"));
    const parsed = JSON.parse(kept) as { parses: unknown[] };
    expect(parsed.parses).toHaveLength(0);
  });

  it("keeps an entry whose identity the file does not state", () => {
    // A parser entry with no `key` is numbered by the parser from its position. There is no stable
    // identity to match against, and dropping the wrong entry is worse than keeping one unticked.
    const text = JSON.stringify({ parses: [{ name: "无名", url: "https://a.example/" }] });
    const p = buildImportPreview(text);
    const kept = keepSelectedEntries(text, p.candidates, new Set());
    const parsed = JSON.parse(kept) as { parses: unknown[] };

    // The entry survives: the alternative is deleting something the user never deselected by name.
    expect(parsed.parses).toHaveLength(1);
  });
});
