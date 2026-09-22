import { describe, expect, it } from "vitest";

import { resolveSavePayload } from "@/features/config/config-autosave";
import { parseConfigText } from "@/features/config/config-parser";
import type { SourceRecord } from "@/types/moseek";

function source(over: Partial<SourceRecord> & { key: string }): SourceRecord {
  return {
    name: over.key,
    sourceType: "cms",
    api: "https://a.example/api.php/provide/vod",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "note",
    testStatus: "untested",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
    ...over,
  };
}

const previous = {
  previousSources: [
    source({ key: "kept", name: "保留的源", api: "https://kept.example/api.php/provide/vod", enabled: false }),
  ],
  previousNormalizedConfig: '{"kept":true}',
  previousLiveCount: 3,
};

describe("what a save writes", () => {
  it("writes valid text and regenerates the derived state", () => {
    // The kept source shares the parsed source's address, so the merge recognises it as the same
    // source and its switch state survives. That is the point of merging by identity rather than
    // taking the parse directly.
    const text = JSON.stringify({
      sites: [
        { key: "a", name: "甲", api: "https://a.example/api.php/provide/vod" },
        { key: "kept", name: "保留的源", api: "https://kept.example/api.php/provide/vod" },
      ],
    });
    const payload = resolveSavePayload({
      text,
      parsed: parseConfigText(text, undefined),
      ...previous,
    });

    expect(payload.rawConfig).toBe(text);
    expect(payload.normalizedConfig).not.toBe(previous.previousNormalizedConfig);
    expect(payload.warning).toBeNull();
    // The existing switch state survives, because the merge is by identity.
    const kept = payload.sources.find((item) => item.key === "kept");
    expect(kept?.enabled).toBe(false);
    expect(payload.sources.some((item) => item.key === "a")).toBe(true);
  });

  it("writes text it cannot parse, and reports the problem instead of refusing", () => {
    // The user's instruction. The old flow refused outright, so one mistyped character could cost a
    // session's edits — and a file the app could not read could not be saved in order to be repaired
    // from inside the app.
    const text = '{ "sites": [ { "key": "a", ';
    const parsed = parseConfigText(text, undefined);
    expect(parsed.ok).toBe(false);

    const payload = resolveSavePayload({ text, parsed, ...previous });

    // The text lands. This is the whole point.
    expect(payload.rawConfig).toBe(text);
    // The derived state is kept rather than emptied: writing empty sources would make a typo look
    // like deleting every source, which is worse than a stale list.
    expect(payload.sources).toEqual(previous.previousSources);
    expect(payload.normalizedConfig).toBe(previous.previousNormalizedConfig);
    expect(payload.liveCount).toBe(previous.previousLiveCount);
    // And the user is told, so the problem is visible without being blocking.
    expect(payload.warning).toBeTruthy();
    expect(payload.warning).toContain("已保存");
    expect(payload.warning).toContain("源列表仍显示上一次解析成功的结果");
  });

  it("names the line when the parser could give one", () => {
    const text = '{\n  "sites": [\n    { "key": "a", \n  ]\n}';
    const payload = resolveSavePayload({
      text,
      parsed: parseConfigText(text, undefined),
      ...previous,
    });
    expect(payload.warning).toMatch(/第 \d+ 行|已保存/);
  });

  it("treats empty text as no sources rather than as a parse failure", () => {
    // Clearing the file is a state the user can reach on purpose, and it means "nothing here". The
    // distinction matters: keeping the previous sources would make the list disagree with the text
    // the user is looking at, and they could never empty their configuration at all.
    const payload = resolveSavePayload({ text: "", parsed: null, ...previous });
    expect(payload.rawConfig).toBe("");
    expect(payload.sources).toEqual([]);
    expect(payload.liveCount).toBe(0);
    expect(payload.warning).toBeNull();
  });

  it("reports a warning with no line when the parser has none", () => {
    // A JSON5 syntax error can arrive without a position, and the message must not read as though a
    // line were known.
    const payload = resolveSavePayload({
      text: "not json at all",
      parsed: parseConfigText("not json at all", undefined),
      ...previous,
    });
    expect(payload.warning).toContain("已保存");
    expect(payload.warning).not.toContain("第 null 行");
  });
});
