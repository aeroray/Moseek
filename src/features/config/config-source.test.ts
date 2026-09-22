import { describe, expect, it } from "vitest";

import {
  readConfigSource,
  readHtmlTitle,
  readMultiRepo,
  stripTrailingHtml,
} from "@/features/config/config-source";

// The fixtures are the real responses, shortened to the part that matters. Each one is a shape the
// user's ten addresses actually produced, so a regression here is a regression on a real address.

describe("reading what a configuration address serves", () => {
  it("passes a plain configuration through", () => {
    const text = '{"sites":[{"key":"a","name":"甲","api":"https://a/x"}]}';
    const source = readConfigSource(text);
    expect(source.kind).toBe("config");
    if (source.kind !== "config") return;
    expect(source.text).toBe(text);
  });

  it("passes a configuration behind // comments through, comments intact", () => {
    // 老刘备 and 小盒子单仓 both open this way. The parser tolerates comments, so removing them here
    // would be a second implementation of something that already works — the comments are only
    // skipped over to find the real first character.
    const text = '//以下内容为互联网收集，只为自用。\n{"sites":[]}';
    const source = readConfigSource(text);
    expect(source.kind).toBe("config");
    if (source.kind !== "config") return;
    expect(source.text).toContain("//以下内容");
    expect(source.text).toContain('"sites"');
  });

  it("drops a leading BOM so the shape checks see the real first character", () => {
    const source = readConfigSource('\uFEFF{"sites":[]}');
    expect(source.kind).toBe("config");
    if (source.kind !== "config") return;
    expect(source.text.startsWith("\uFEFF")).toBe(false);
    expect(source.text).toBe('{"sites":[]}');
  });

  it("reads a 多仓 list as a list rather than as a broken configuration", () => {
    // 小盒子多仓 and 挺好分享多仓. Parsing this as a configuration would fail with "no sites", which
    // says nothing about what the address actually is.
    const text = JSON.stringify({
      urls: [
        { name: "🚀小盒子", url: "http://xhztv.top/xhz" },
        { name: "🐔肥猫", url: "http://我不是.肥猫.live/接口禁止贩卖" },
      ],
    });
    const source = readConfigSource(text);
    expect(source.kind).toBe("multi-repo");
    if (source.kind !== "multi-repo") return;
    expect(source.entries).toHaveLength(2);
    expect(source.entries[0]).toEqual({ name: "🚀小盒子", url: "http://xhztv.top/xhz" });
    // The message has to say what this is, because "it is not a configuration" alone leaves the user
    // unsure whether their address was wrong.
    expect(source.note).toContain("多仓");
    expect(source.note).toContain("2 个配置地址");
  });

  it("reads a 多仓 list whose name is missing, falling back to the URL", () => {
    const source = readConfigSource(JSON.stringify({ urls: [{ url: "http://a.example/x" }] }));
    expect(source.kind).toBe("multi-repo");
    if (source.kind !== "multi-repo") return;
    expect(source.entries[0]).toEqual({ name: "http://a.example/x", url: "http://a.example/x" });
  });

  it("reads a 多仓 list written with a BOM and comments", () => {
    // The measured 小盒子多仓 response. Hand-written documents mix these, and refusing one would be
    // refusing a working address.
    const text = '\uFEFF//多仓配置\n{"urls":[{"name":"甲","url":"http://a.example/1"}]}';
    const source = readConfigSource(text);
    expect(source.kind).toBe("multi-repo");
    if (source.kind !== "multi-repo") return;
    expect(source.entries).toHaveLength(1);
  });

  it("does not mistake a configuration for a 多仓 list", () => {
    // `urls` appears inside plenty of configurations — as a play-list field. Only a top-level array
    // of address-bearing objects is a subscription list.
    const text = JSON.stringify({
      sites: [{ key: "a", name: "甲", api: "https://a/x", urls: ["https://a/1"] }],
    });
    const source = readConfigSource(text);
    expect(source.kind).toBe("config");
  });

  it("does not mistake a top-level urls array of strings for a 多仓 list", () => {
    const source = readConfigSource(JSON.stringify({ urls: ["https://a/1", "https://a/2"] }));
    expect(source.kind).toBe("config");
  });

  it("reports a landing page as a page, naming it", () => {
    // 王二小 and 嗷呜. Reporting a JSON syntax error at character 0 would be true and useless: the
    // user pasted a real address that happens to be a web page.
    const html =
      '<!doctype html><html><head><title>嗷呜接口主页</title></head><body>hi</body></html>';
    const source = readConfigSource(html);
    expect(source.kind).toBe("landing-page");
    if (source.kind !== "landing-page") return;
    expect(source.title).toBe("嗷呜接口主页");
    expect(source.note).toContain("嗷呜接口主页");
    expect(source.note).toContain("不是配置文件");
  });

  it("strips an HTML footer appended after a JSON document", () => {
    // 拾光多仓: a complete JSON document, then a <div>. The footer is markup a publisher's site
    // template added, and it makes the document unparseable.
    const text = `${JSON.stringify({ urls: [{ name: "甲", url: "http://a.example/1" }] })}
<div style="text-align: center;"><div style="position:relative;">
</div></div>`;
    const source = readConfigSource(text);
    expect(source.kind).toBe("multi-repo");
    if (source.kind !== "multi-repo") return;
    expect(source.entries).toHaveLength(1);
  });

  it("keeps a < inside a configuration string", () => {
    // The footer strip must not fire on a `<` that is part of the data. Cutting there would delete
    // the end of a working configuration, which is worse than the problem it solves.
    const text = '{\n  "warningText": "a < b",\n  "sites": []\n}';
    expect(stripTrailingHtml(text)).toBeNull();
    const source = readConfigSource(text);
    expect(source.kind).toBe("config");
    if (source.kind !== "config") return;
    expect(source.text).toContain("a < b");
  });

  it("carries the fetch's own note through", () => {
    // A picture that had to be unwrapped is worth telling the user about, and that note comes from the
    // Rust side. Dropping it here would hide the fact that their file was a JPEG.
    const source = readConfigSource('{"sites":[]}', "已从 JPEG 图片中取出内嵌的配置");
    expect(source.kind).toBe("config");
    if (source.kind !== "config") return;
    expect(source.note).toBe("已从 JPEG 图片中取出内嵌的配置");
  });
});

describe("the helpers on their own", () => {
  it("reads the title of a page with attributes on the tag", () => {
    expect(readHtmlTitle('<title lang="zh">接口主页</title>')).toBe("接口主页");
    expect(readHtmlTitle("<html><body>no title</body></html>")).toBeUndefined();
  });

  it("returns null for a 多仓 list with no usable entries", () => {
    expect(readMultiRepo(JSON.stringify({ urls: [] }))).toBeNull();
    expect(readMultiRepo(JSON.stringify({ urls: [{ name: "x" }] }))).toBeNull();
    expect(readMultiRepo('{"sites":[]}')).toBeNull();
    expect(readMultiRepo("not json")).toBeNull();
  });

  it("returns null when there is no footer to strip", () => {
    expect(stripTrailingHtml('{"sites":[]}')).toBeNull();
    expect(stripTrailingHtml("")).toBeNull();
  });

  it("returns null when removing the footer would not leave a document", () => {
    // The cut is only taken when the remainder parses, so an unrelated `<` cannot shorten a
    // configuration that was already invalid for some other reason.
    expect(stripTrailingHtml("{\n not json\n<div>x</div>")).toBeNull();
  });
});
