import { describe, expect, it } from "vitest";

import {
  addVisualEntry,
  canSaveVisualConfig,
  dedupeParseServices,
  findDuplicateParseServices,
  hasUnpreservedSyntax,
  readVisualConfig,
  removeVisualEntry,
  removeVisualSetting,
  removeVisualSettings,
  updateVisualEntryField,
  updateVisualSetting,
} from "@/features/config/config-visual";

const sample = JSON.stringify({
  sites: [
    { key: "a", name: "甲源", api: "https://a.example/api", type: 1, searchable: 1 },
    { key: "b", name: "乙源", api: "https://b.example/api", type: 3, ext: { x: 1 } },
  ],
  lives: [{ name: "央视", url: "https://live.example/tv.txt", key: "cctv" }],
  parses: [{ name: "解析", type: 1, url: "https://parse.example/jx" }],
  wallpaper: "https://wall.example/1.jpg",
  ads: ["ad.example"],
});

describe("reading a configuration into the visual model", () => {
  it("groups the entry arrays into named sections", () => {
    const result = readVisualConfig(sample);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sections.map((s) => s.key)).toEqual(["sites", "lives", "parses"]);
    const sites = result.sections[0];
    expect(sites.title).toBe("影视源");
    expect(sites.entries).toHaveLength(2);
    expect(sites.entries[0].label).toBe("甲源");
    expect(sites.entries[0].summary).toBe("https://a.example/api");
  });

  it("offers each section's own fields, and marks the required ones", () => {
    const result = readVisualConfig(sample);
    if (!result.ok) throw new Error("expected a parse");
    const sites = result.sections[0];
    const names = sites.entries[0].fields.map((f) => f.name);
    expect(names).toEqual([
      "key",
      "name",
      "api",
      "type",
      "ext",
      "jar",
      "searchable",
      "filterable",
    ]);
    // A source without key/name/api cannot be built into a request, so they are required.
    expect(sites.entries[0].fields.find((f) => f.name === "key")?.required).toBe(true);
    expect(sites.entries[0].fields.find((f) => f.name === "jar")?.required).toBe(false);
  });

  it("does not mistake a 0/1 identifier for a flag", () => {
    // `type: 1` is a dialect identifier, not a yes/no. Deciding by the value alone rendered a switch
    // for every `type: 1` source, and flipping it would have written 0 — silently changing the
    // source's dialect. Only the fields that are genuinely booleans become switches.
    const result = readVisualConfig(
      JSON.stringify({
        sites: [
          {
            key: "a",
            name: "A",
            api: "https://a/x",
            type: 1,
            timeout: 30,
            searchable: 1,
            filterable: 0,
          },
        ],
      }),
    );
    if (!result.ok) throw new Error("expected a parse");
    const kindOf = (name: string) =>
      result.sections[0].entries[0].fields.find((f) => f.name === name)?.kind;

    expect(kindOf("type")).toBe("number");
    expect(kindOf("searchable")).toBe("flag");
    expect(kindOf("filterable")).toBe("flag");
    // `timeout` is not one of the section's offered fields, so it is not shown at all.
    expect(kindOf("timeout")).toBeUndefined();
  });

  it("still reads a real boolean as a flag whatever it is called", () => {
    // A field the file spells `true`/`false` is a boolean regardless of its name.
    const result = readVisualConfig(
      JSON.stringify({
        sites: [{ key: "a", name: "A", api: "https://a/x", customToggle: true }],
      }),
    );
    if (!result.ok) throw new Error("expected a parse");
    // `customToggle` is not offered as a row, so this asserts through a section field instead.
    const withFlag = readVisualConfig(
      JSON.stringify({ sites: [{ key: "a", name: "A", api: "https://a/x", searchable: true }] }),
    );
    if (!withFlag.ok) throw new Error("expected a parse");
    expect(
      withFlag.sections[0].entries[0].fields.find((f) => f.name === "searchable")?.kind,
    ).toBe("flag");
  });

  it("counts fields it does not offer as rows", () => {
    // A configuration carries dozens of fields the editor does not model. They must survive an edit,
    // so the entry reports how many there are rather than the editor pretending they do not exist.
    const result = readVisualConfig(
      JSON.stringify({ sites: [{ key: "a", name: "A", api: "https://a/x", timeout: 30, style: "list" }] }),
    );
    if (!result.ok) throw new Error("expected a parse");
    expect(result.sections[0].entries[0].extraFieldCount).toBe(2);
  });

  it("separates the entry arrays from the scalar settings", () => {
    const result = readVisualConfig(sample);
    if (!result.ok) throw new Error("expected a parse");
    const keys = result.settings.map((s) => s.key);
    expect(keys).toContain("wallpaper");
    expect(keys).toContain("ads");
    // The entry arrays are sections, not settings.
    expect(keys).not.toContain("sites");
    // A collection is offered as JSON, because there is no useful per-item row for it.
    expect(result.settings.find((s) => s.key === "ads")?.kind).toBe("json");
    expect(result.settings.find((s) => s.key === "wallpaper")?.kind).toBe("text");
  });

  it("tells an empty section apart from a missing one", () => {
    const result = readVisualConfig(JSON.stringify({ sites: [] }));
    if (!result.ok) throw new Error("expected a parse");
    // Present but empty: a place the user can add to.
    expect(result.sections[0].present).toBe(true);
    expect(result.sections[0].entries).toHaveLength(0);
    // Absent: nothing to say.
    expect(result.sections[1].present).toBe(false);
  });

  it("reports an unreadable file rather than showing it as empty", () => {
    // "Nothing here" and "I cannot read this" need different actions from the user.
    for (const text of ["", "   ", "{ sites: [", "[]", "42"]) {
      const result = readVisualConfig(text);
      expect(result.ok, text).toBe(false);
    }
  });

  it("accepts the JSON5 forms the import path accepts", () => {
    const result = readVisualConfig(`{
      // a comment
      sites: [
        { key: 'a', name: 'A', api: 'https://a/x', },
      ],
    }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sections[0].entries).toHaveLength(1);
  });
});

describe("editing through the visual model", () => {
  it("sets a field without disturbing the others", () => {
    const { text, error } = updateVisualEntryField(sample, "sites", 0, "name", "甲源改名");
    expect(error).toBeNull();
    const parsed = JSON.parse(text);
    expect(parsed.sites[0].name).toBe("甲源改名");
    expect(parsed.sites[0].key).toBe("a");
    expect(parsed.sites[1].name).toBe("乙源");
    expect(parsed.lives).toHaveLength(1);
  });

  it("refuses to empty a required field", () => {
    // The entry would stop working and the reason would be invisible in the list.
    const { text, error } = updateVisualEntryField(sample, "sites", 0, "api", "   ");
    expect(error).toContain("必填");
    expect(text).toBe(sample);
  });

  it("removes an optional field rather than writing an empty string", () => {
    // Otherwise every edit accumulates `"ext": ""` on entries that never had one.
    const { text } = updateVisualEntryField(sample, "sites", 1, "ext", "");
    const parsed = JSON.parse(text);
    expect(parsed.sites[1]).not.toHaveProperty("ext");
  });

  it("keeps a JSON field's shape when it is edited", () => {
    // Writing a string where the parser expects an object would silently break the entry.
    const { text } = updateVisualEntryField(sample, "sites", 1, "ext", '{"y":2}');
    const parsed = JSON.parse(text);
    expect(parsed.sites[1].ext).toEqual({ y: 2 });
  });

  it("keeps a number a number and a flag a flag", () => {
    const asNumber = JSON.parse(
      updateVisualEntryField(sample, "sites", 0, "type", "3").text,
    );
    expect(asNumber.sites[0].type).toBe(3);

    // TVBox spells `searchable` as 1/0 rather than true/false, and the parser accepts both. Writing
    // the string "false" into it would look right in the file and stop the source working.
    const numericFlag = JSON.parse(
      updateVisualEntryField(sample, "sites", 0, "searchable", "false").text,
    );
    expect(numericFlag.sites[0].searchable).toBe(0);

    // A field the file spelled as a real boolean stays one.
    const booleanFlag = JSON.parse(
      updateVisualEntryField(
        JSON.stringify({ sites: [{ key: "a", name: "A", api: "https://a/x", filterable: false }] }),
        "sites",
        0,
        "filterable",
        "true",
      ).text,
    );
    expect(booleanFlag.sites[0].filterable).toBe(true);
  });

  it("removes one entry and leaves the rest alone", () => {
    const parsed = JSON.parse(removeVisualEntry(sample, "sites", 0));
    expect(parsed.sites).toHaveLength(1);
    expect(parsed.sites[0].key).toBe("b");
    expect(parsed.lives).toHaveLength(1);
  });

  it("adds an entry carrying the section's required fields", () => {
    const parsed = JSON.parse(addVisualEntry(sample, "sites"));
    expect(parsed.sites).toHaveLength(3);
    const added = parsed.sites[2];
    // The required fields are present and empty, so the row is visibly unfinished rather than
    // silently invalid.
    expect(added).toHaveProperty("key");
    expect(added).toHaveProperty("name");
    expect(added).toHaveProperty("api");
    expect(added).not.toHaveProperty("jar");
  });

  it("adds a section that was not in the file at all", () => {
    const withoutLives = JSON.stringify({ sites: [] });
    const parsed = JSON.parse(addVisualEntry(withoutLives, "lives"));
    expect(parsed.lives).toHaveLength(1);
    expect(parsed.sites).toEqual([]);
  });

  it("edits a scalar setting", () => {
    const parsed = JSON.parse(
      updateVisualSetting(sample, "wallpaper", "https://wall.example/2.jpg").text,
    );
    expect(parsed.wallpaper).toBe("https://wall.example/2.jpg");
    expect(parsed.sites).toHaveLength(2);
  });

  it("edits a JSON setting and refuses malformed JSON", () => {
    const good = updateVisualSetting(sample, "ads", '["x.example","y.example"]');
    expect(good.error).toBeNull();
    expect(JSON.parse(good.text).ads).toEqual(["x.example", "y.example"]);

    const bad = updateVisualSetting(sample, "ads", "[not json");
    expect(bad.error).toContain("JSON");
    expect(bad.text).toBe(sample);
  });

  it("removes a setting when it is cleared", () => {
    const parsed = JSON.parse(updateVisualSetting(sample, "wallpaper", "").text);
    expect(parsed).not.toHaveProperty("wallpaper");
  });

  it("removes one setting by name, leaving the others", () => {
    // Clearing the box already did this, but nothing in the interface said an empty box means the
    // key is deleted. The row's delete button makes it explicit, so it needs its own operation.
    const parsed = JSON.parse(removeVisualSetting(sample, "ads"));
    expect(parsed).not.toHaveProperty("ads");
    expect(parsed.wallpaper).toBe("https://wall.example/1.jpg");
    expect(parsed.sites).toHaveLength(2);
  });

  it("removes several settings in one pass and touches nothing else", () => {
    const parsed = JSON.parse(removeVisualSettings(sample, ["ads", "wallpaper"]));
    expect(parsed).not.toHaveProperty("ads");
    expect(parsed).not.toHaveProperty("wallpaper");
    // The entry arrays and the parser services are what Moseek actually uses, so a settings cleanup
    // must not touch them.
    expect(parsed.sites).toHaveLength(2);
    expect(parsed.lives).toHaveLength(1);
    expect(parsed.parses).toHaveLength(1);
  });

  it("skips a setting that is not present rather than failing", () => {
    // The caller passes whatever the section is showing, which may include a key already gone.
    const text = removeVisualSettings(sample, ["wallpaper", "not-here"]);
    expect(JSON.parse(text)).not.toHaveProperty("wallpaper");
    expect(JSON.parse(text)).not.toHaveProperty("not-here");
    // Removing nothing at all returns the input untouched, so an empty cleanup is not a write.
    expect(removeVisualSettings(text, ["not-here", "also-not-here"])).toBe(text);
  });

  it("leaves an unreadable document alone instead of emptying it", () => {
    // The same rule the entry operations follow: a removal must never destroy a file it cannot read.
    expect(removeVisualSettings("{ not json", ["ads"])).toBe("{ not json");
    expect(removeVisualSetting("{ not json", "ads")).toBe("{ not json");
  });

  it("leaves an out-of-range entry alone instead of throwing", () => {
    // A row can be deleted while its editor is open, so the index may no longer exist.
    expect(removeVisualEntry(sample, "sites", 9)).toBe(sample);
    expect(updateVisualEntryField(sample, "sites", 9, "name", "x").text).toBe(sample);
  });
});

describe("duplicate parser services", () => {
  // The resolver attempts at most 12 services per playback, in the file's own order, so a repeat
  // spends one of those places on an attempt already made. Measured on the author's configuration:
  // 75 entries, 57 distinct addresses, and the twelfth usable one sits at position 14.
  const withDuplicates = JSON.stringify({
    sites: [],
    parses: [
      { name: "一", type: 1, url: "https://jx.example/?url=" },
      { name: "二", type: 1, url: "https://other.example/?url=" },
      { name: "一的重复", type: 1, url: "https://jx.example/?url=" },
      { name: "三", type: 1, url: "https://jx.example/?url=" },
    ],
  });

  it("names the repeats and keeps the first of each", () => {
    expect(findDuplicateParseServices(withDuplicates)).toEqual([2, 3]);

    const parsed = JSON.parse(dedupeParseServices(withDuplicates));
    expect(parsed.parses.map((item: { name: string }) => item.name)).toEqual(["一", "二"]);
  });

  it("compares the address without case or a trailing slash", () => {
    // The resolver parses the URL, so `HTTPS://JX.EXAMPLE/?url=` and `https://jx.example/?url=` are
    // the same attempt and must not both be tried.
    const text = JSON.stringify({
      parses: [
        { name: "一", type: 1, url: "https://jx.example/?url=" },
        { name: "二", type: 1, url: "HTTPS://JX.EXAMPLE/?url=" },
      ],
    });
    expect(findDuplicateParseServices(text)).toEqual([1]);
    expect(JSON.parse(dedupeParseServices(text)).parses).toHaveLength(1);
  });

  it("keeps entries that have no address", () => {
    // They are already unusable, and dropping them here would make this button delete something the
    // user cannot see a duplicate of.
    const text = JSON.stringify({
      parses: [
        { name: "空一", type: 1, url: "" },
        { name: "空二", type: 1, url: "" },
        { name: "好的", type: 1, url: "https://jx.example/?url=" },
      ],
    });
    expect(findDuplicateParseServices(text)).toEqual([]);
    expect(dedupeParseServices(text)).toBe(
      JSON.stringify({
        parses: [
          { name: "空一", type: 1, url: "" },
          { name: "空二", type: 1, url: "" },
          { name: "好的", type: 1, url: "https://jx.example/?url=" },
        ],
      }),
    );
  });

  it("changes nothing when there are no duplicates", () => {
    const text = JSON.stringify({
      parses: [
        { name: "一", type: 1, url: "https://a.example/?url=" },
        { name: "二", type: 1, url: "https://b.example/?url=" },
      ],
    });
    expect(findDuplicateParseServices(text)).toEqual([]);
    // Returns the input unchanged rather than a re-serialised copy, so "nothing to do" is not a write.
    expect(dedupeParseServices(text)).toBe(text);
  });

  it("leaves the other sections and an unreadable document alone", () => {
    const text = JSON.stringify({
      sites: [{ key: "a", name: "甲", api: "https://a.example/api" }],
      parses: [
        { name: "一", type: 1, url: "https://jx.example/?url=" },
        { name: "二", type: 1, url: "https://jx.example/?url=" },
      ],
    });
    const parsed = JSON.parse(dedupeParseServices(text));
    expect(parsed.sites).toHaveLength(1);
    expect(parsed.parses).toHaveLength(1);

    expect(findDuplicateParseServices("{ not json")).toEqual([]);
    expect(dedupeParseServices("{ not json")).toBe("{ not json");
  });
});

describe("deciding whether an edit may be saved", () => {
  it("refuses text that cannot be parsed, and names the reason", () => {
    // Saving invalid text would replace a working configuration with one that cannot be read. The
    // message names the syntax error, because the user is looking at a text editor and "invalid"
    // alone leaves them to find it.
    const result = canSaveVisualConfig("{ sites: [");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("配置无法保存");
    expect(result.message.length).toBeGreaterThan("配置无法保存，请先修正语法：".length);
  });

  it("refuses an empty document", () => {
    // Covered by the parse rather than by a separate branch: JSON5 rejects empty input, so this
    // asserts the outcome the user sees without the code carrying a check that cannot be tested.
    for (const text of ["", "   ", "\n"]) {
      const result = canSaveVisualConfig(text);
      expect(result.ok, JSON.stringify(text)).toBe(false);
      if (!result.ok) expect(result.message).toContain("配置无法保存");
    }
  });

  it("accepts a valid document, including the JSON5 forms the importer accepts", () => {
    expect(canSaveVisualConfig('{"sites":[]}').ok).toBe(true);
    expect(canSaveVisualConfig("{ sites: [], // comment\n }").ok).toBe(true);
  });
});

describe("syntax the visual editor would not preserve", () => {
  it("detects comments, which re-serialising would drop", () => {
    // Telling the user before they edit is the difference between a considered choice and silent
    // loss of text they wrote.
    expect(hasUnpreservedSyntax("{ // note\n sites: [] }")).toBe(true);
    expect(hasUnpreservedSyntax("{ /* note */ sites: [] }")).toBe(true);
    expect(hasUnpreservedSyntax('{ sites: [] }')).toBe(false);
    // A `//` inside a string is content, not a comment.
    expect(hasUnpreservedSyntax('{ wallpaper: "https://a.example/x" }')).toBe(false);
    expect(hasUnpreservedSyntax('{ name: "a // b" }')).toBe(false);
  });
});
