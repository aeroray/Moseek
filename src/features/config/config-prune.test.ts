import { describe, expect, it } from "vitest";

import {
  parseConfigText,
  pruneUnsupportedConfigText,
  pruneUnsupportedEntries,
} from "@/features/config/config-parser";

/**
 * The removal of the families Moseek will never run.
 *
 * The user's decision: an adapter we cannot support has no business staying on screen, because
 * recognising it tells the reader nothing and this application is never going to implement it. Five
 * such adapters used to be listed — drpy, AppMao, remote JAR, spider and CatVod JS — and an entry
 * belonging to one of them is now removed from the configuration outright.
 *
 * **The risk in this feature is not failing to remove something; it is removing something that
 * works.** A wrong deletion silently takes a source out of the user's file, and the user has no way
 * to know it happened. So most of what follows pins the entries that must survive, and the shapes are
 * the real ones: an XBPQ source is `type: 3` and ships a JAR, exactly like the spiders being removed.
 */

/** An XBPQ payload from a real imported configuration. */
const XBPQ_EXT = JSON.stringify({
  分类url: "https://www.freeok.vip/vod-show/{cateId}---{catePg}---.html",
  分类: "FREE电影&FREE剧集",
  分类值: "1&2",
  嗅探词: "m3u8#.m3u8#.mp4",
});

function prune(raw: Record<string, unknown>, baseUrl?: string) {
  return pruneUnsupportedEntries(raw, baseUrl);
}

describe("removing the sources Moseek can never run", () => {
  it("drops a drpy source and keeps the ordinary one beside it", () => {
    const { raw, removed } = prune({
      sites: [
        { key: "ordinary", name: "普通源", api: "https://cms.example/api" },
        {
          key: "drpy-one",
          name: "drpy 源",
          api: "https://example.com/lib/drpy2.min.js",
        },
        {
          key: "ext-one",
          name: "扩展 drpy",
          type: 3,
          api: "csp_DouDou",
          ext: "./libs/js/虎牙直播.js",
        },
      ],
    });

    expect(removed).toBe(2);
    expect(raw.sites).toHaveLength(1);
    expect((raw.sites as { key: string }[])[0].key).toBe("ordinary");
  });

  it("drops every remaining family that would have to execute something", () => {
    // One case per family, including the ones whose only hint is a field rather than a name: a bare
    // `type: 3` spider, and a source whose sole marker is the JAR it wants to download.
    const sites = [
      { key: "a", name: "AppMao", type: 3, api: "csp_AppMao", ext: "FbjDcUxPqpfNr0QF" },
      { key: "b", name: "JAR 源", api: "https://example.com/api", jar: "https://x/1.jar" },
      { key: "c", name: "裸 Spider", type: 3, api: "https://example.com/spider" },
      { key: "d", name: "小猫 JS", type: 1, api: "https://example.com", extra: { js: { search: "s" } } },
    ];
    const { raw, removed } = prune({ sites });

    expect(removed).toBe(4);
    expect(raw.sites).toHaveLength(0);
  });

  it("keeps an XBPQ source, which looks exactly like a spider", () => {
    // **The dangerous case.** This entry is `type: 3` with a JAR, so every raw marker says "spider";
    // the configuration it carries is a declarative vocabulary Moseek reads today. Measured on the
    // author's database, 60 working sources have this shape, so a check reading only the markers
    // would delete all of them.
    const { raw, removed } = prune({
      sites: [
        {
          key: "fok",
          name: "🌙┃夸克┃影视",
          type: 3,
          api: "csp_XBPQ",
          ext: XBPQ_EXT,
          jar: "https://example.com/1.jar;md5;bb155c3f0133bbce4756ad52003f5968",
        },
      ],
    });

    expect(removed).toBe(0);
    expect(raw.sites).toHaveLength(1);
  });

  it("keeps a source whose family was recognised from its ext alone", () => {
    // The other shape of the same trap: neither key nor api names the family, so the *protocol* the
    // parser derived from the payload is the only evidence that this is declarative. It is `type: 3`
    // with a JAR as well.
    const { raw, removed } = prune({
      sites: [
        {
          key: "奈飞中文",
          name: "🎗┃奈飞┃秒播",
          type: 3,
          api: "https://example.com/api",
          ext: XBPQ_EXT,
          jar: "https://example.com/ttkx.jar",
        },
      ],
    });

    expect(removed).toBe(0);
    expect(raw.sites).toHaveLength(1);
  });

  it("keeps a source whose name merely contains a family marker", () => {
    // `kitty` is the name of a dialect, not of an engine, and it turns up in source names. Matching
    // the word would mark an ordinary `Kitty影视` API as remote code and delete it.
    for (const key of ["Kitty影视", "kitty-cms", "mycat"]) {
      const { removed } = prune({
        sites: [{ key, name: "猫影视", api: "https://cms.example/api" }],
      });
      expect(removed, key).toBe(0);
    }
  });

  it("keeps a live source whose address is relative or bare", () => {
    // **Pruning must not race the repair.** A relative path (`./FM.json`) or a bare token (`yqk`) is
    // resolved against the document's base URL on import, so treating it as a verdict here would
    // delete sources that are about to work — including the 19 the user's own database carried.
    const { raw, removed } = prune({
      lives: [
        { name: "FM", url: "./FM.json" },
        { name: "IPV6", url: "./lib/tv/ipv6.m3u" },
        { name: "名字", url: "yqk" },
        { name: "直播链接自定义", url: "直播链接自定义" },
      ],
    });

    expect(removed).toBe(0);
    expect(raw.lives).toHaveLength(4);
  });

  it("keeps a live source with a private scheme, which is not a family we decided against", () => {
    // `proxy://` is a protocol rather than a plugin, and the user can point it somewhere usable. The
    // previous vocabulary called it 无法适配 and left it alone; so does this.
    const { raw, removed } = prune({
      lives: [{ name: "私有", url: "proxy://wexian/1" }],
    });

    expect(removed).toBe(0);
    expect(raw.lives).toHaveLength(1);
  });

  it("leaves the other collections untouched", () => {
    // `parses` holds playback resolvers rather than sources, and the top-level settings are TVBox's
    // own. Removing a source must not quietly drop a resolver or a setting.
    const before = {
      sites: [{ key: "drpy", name: "d", api: "https://x/drpy2.min.js" }],
      lives: [],
      parses: [{ name: "解析甲", type: 1, url: "https://jx.example/?url=" }],
      wallpaper: "https://example.com/bg.jpg",
      spider: "https://example.com/spider.jar",
    };
    const { raw, removed } = prune(before);

    expect(removed).toBe(1);
    expect(raw.parses).toEqual(before.parses);
    expect(raw.wallpaper).toBe(before.wallpaper);
    expect(raw.spider).toBe(before.spider);
  });

  it("does not invent a collection the document did not have", () => {
    // A Kitty document keeps its entries under `data`. Pruning must not add an empty `sites` beside
    // it, nor move the survivors into one.
    const { raw, removed } = prune({
      data: [
        { id: "keep", name: "保留", api: "https://cms.example/api" },
        { id: "drop", name: "丢弃", api: "https://x/drpy2.min.js" },
      ],
    });

    expect(removed).toBe(1);
    expect(raw).not.toHaveProperty("sites");
    expect(raw.data).toHaveLength(1);
    expect((raw.data as { id: string }[])[0].id).toBe("keep");
  });

  it("returns the same object when there is nothing to remove", () => {
    // Identity, not just equality: the callers compare text and objects to decide whether to write,
    // so a function that rebuilds an unchanged document would cause needless saves.
    const raw = {
      sites: [{ key: "ok", name: "好源", api: "https://cms.example/api" }],
    };
    const result = prune(raw);

    expect(result.removed).toBe(0);
    expect(result.raw).toBe(raw);
  });

  it("leaves an entry it cannot read alone", () => {
    // Failing to understand something is not evidence that it is unusable, and this function's only
    // real risk is deleting a source that works.
    const { raw, removed } = prune({
      sites: ["not an object", 42, { key: "x", name: "x", api: { nested: true } }],
    });

    expect(removed).toBe(0);
    expect(raw.sites).toHaveLength(3);
  });

  it("removes nothing when the document itself cannot be read", () => {
    const broken = "{ this is not JSON5 at all {{{";
    const result = pruneUnsupportedConfigText(broken);

    expect(result.removed).toBe(0);
    expect(result.text).toBe(broken);
  });

  it("rewrites the text only when something was removed", () => {
    const kept = JSON.stringify({
      sites: [{ key: "ok", name: "好源", api: "https://cms.example/api" }],
    });
    expect(pruneUnsupportedConfigText(kept).text).toBe(kept);

    const withBlocked = JSON.stringify({
      sites: [
        { key: "ok", name: "好源", api: "https://cms.example/api" },
        { key: "bad", name: "drpy", api: "https://x/drpy2.min.js" },
      ],
    });
    const pruned = pruneUnsupportedConfigText(withBlocked);

    expect(pruned.removed).toBe(1);
    expect(pruned.text).not.toBe(withBlocked);
    expect(JSON.parse(pruned.text).sites).toHaveLength(1);
  });

  it("is idempotent, which is what keeps the autosave from looping", () => {
    // The autosave writes the pruned text and stores it as the document, so the next pass sees text
    // that is already clean. If a second pass removed anything — or rewrote the text — every save
    // would schedule another one, which is a write loop this project has already fixed once.
    const once = pruneUnsupportedConfigText(
      JSON.stringify({
        sites: [
          { key: "ok", name: "好源", api: "https://cms.example/api" },
          { key: "bad", name: "drpy", api: "https://x/drpy2.min.js" },
        ],
      }),
    );
    const twice = pruneUnsupportedConfigText(once.text);

    expect(twice.removed).toBe(0);
    expect(twice.text).toBe(once.text);
  });

  it("leaves the parse of a pruned document with nothing unsupported in it", () => {
    // The point of pruning the text rather than the list: the two halves of a stored document agree
    // by construction, so no row can appear for an entry the file no longer contains.
    const pruned = pruneUnsupportedConfigText(
      JSON.stringify({
        sites: [
          { key: "ok", name: "好源", api: "https://cms.example/api" },
          { key: "bad", name: "drpy", api: "https://x/drpy2.min.js" },
        ],
      }),
    );
    const parsed = parseConfigText(pruned.text);

    expect(parsed.ok).toBe(true);
    expect(parsed.sources.map((source) => source.key)).toEqual(["ok"]);
  });
});
