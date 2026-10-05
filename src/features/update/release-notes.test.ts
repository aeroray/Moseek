import { describe, expect, it } from "vitest";

import {
  parseInline,
  parseReleaseNotes,
} from "@/features/update/release-notes";

/**
 * The release-notes parser.
 *
 * It exists because the notes travel in `latest.json`, which the minisign signature does **not**
 * cover — the signature is over the installer. So the text is untrusted input, and the parser's job
 * is to turn it into plain strings that React will escape. These tests pin that the output is
 * strings, never markup, and that nothing the author wrote is silently dropped.
 */
describe("parseReleaseNotes", () => {
  it("reads headings at two weights and clamps h1 down", () => {
    const blocks = parseReleaseNotes("# 一级\n## 二级\n### 三级");
    expect(blocks).toEqual([
      // `#` is clamped to 2: these notes render inside a settings card, where a document-level
      // heading would out-shout the page around it.
      { kind: "heading", level: 2, text: "一级" },
      { kind: "heading", level: 2, text: "二级" },
      { kind: "heading", level: 3, text: "三级" },
    ]);
  });

  it("keeps one list across the blank lines between bullets", () => {
    // Our notes separate every bullet with a blank line. Flushing the list on a blank line would
    // turn each section into a stack of one-item lists, which reads as separate paragraphs.
    const blocks = parseReleaseNotes("- 甲\n\n- 乙\n\n- 丙");
    expect(blocks).toEqual([{ kind: "list", items: ["甲", "乙", "丙"] }]);
  });

  it("treats an indented line as a continuation of the bullet above it", () => {
    // The English translation sits indented under its bullet, and the newline has to survive or the
    // two run together into one sentence.
    const blocks = parseReleaseNotes("- 修复导出\n    Fixed the export");
    expect(blocks).toEqual([
      { kind: "list", items: ["修复导出\nFixed the export"] },
    ]);
  });

  it("keeps unrecognised lines as plain text instead of dropping them", () => {
    // A note must never disappear because the parser did not recognise its shape.
    const blocks = parseReleaseNotes("普通一行\n> 引用不是我们用的语法");
    expect(blocks).toEqual([
      { kind: "text", text: "普通一行" },
      { kind: "text", text: "> 引用不是我们用的语法" },
    ]);
  });

  it("returns no blocks for empty input", () => {
    expect(parseReleaseNotes("")).toEqual([]);
    expect(parseReleaseNotes("   \n\n  ")).toEqual([]);
  });

  it("hands back plain strings, so markup cannot reach the DOM as markup", () => {
    // The security property: whatever the manifest says ends up as text. If this ever returned
    // HTML, anyone able to answer the endpoint could inject into the settings page.
    const blocks = parseReleaseNotes('<img src=x onerror="alert(1)">\n\n- <script>alert(2)</script>');
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("<img src=x");
    // Present as a *string*, which React escapes — the assertion is about the type, not the content.
    expect(blocks[0]).toEqual({
      kind: "text",
      text: '<img src=x onerror="alert(1)">',
    });
    expect(blocks[1]).toEqual({
      kind: "list",
      items: ["<script>alert(2)</script>"],
    });
  });
});

describe("parseInline", () => {
  it("splits bold runs out of surrounding text", () => {
    expect(parseInline("修复 **导出** 按钮")).toEqual([
      { bold: false, text: "修复 " },
      { bold: true, text: "导出" },
      { bold: false, text: " 按钮" },
    ]);
  });

  it("leaves a lone asterisk alone", () => {
    // Our notes use `*` inside words far more often than as emphasis.
    expect(parseInline("a * b")).toEqual([{ bold: false, text: "a * b" }]);
  });

  it("returns the whole string when there is nothing to split", () => {
    expect(parseInline("普通文本")).toEqual([{ bold: false, text: "普通文本" }]);
  });
});
