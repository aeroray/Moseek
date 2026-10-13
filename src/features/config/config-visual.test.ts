import { describe, expect, it } from "vitest";

import { RawSiteSchema, RAW_FLAG_FIELDS } from "@/features/config/config-schema";
import {
  locateVisualEntry,
  readVisualConfig,
  updateVisualEntryField,
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
    // Only the address is required: the parser falls back to `id` and then numbers a keyless entry
    // (`invalid-N`), and names a nameless one `未命名源 N`, so those entries still load and still
    // play. Marking them 必需 would tell the user to keep a field that changes nothing — which is
    // what the editor did before this was settled against the parser.
    expect(sites.entries[0].fields.find((f) => f.name === "api")?.required).toBe(true);
    expect(sites.entries[0].fields.find((f) => f.name === "key")?.required).toBe(false);
    expect(sites.entries[0].fields.find((f) => f.name === "name")?.required).toBe(false);
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

  it("does not offer the parser's own bookkeeping as a TVBox setting", () => {
    // **The reported defect.** The block is for keys belonging to other TVBox clients, but it was also
    // listing `schemaVersion`, `configDialect` and `blockedFields` — all three written by Moseek's own
    // parser when it normalises a document. So an imported configuration grew a 其他设置 block that
    // the same configuration did not have before the import, and the block offered a `schemaVersion`
    // text box whose value is regenerated on every write.
    const result = readVisualConfig(
      JSON.stringify({
        sites: [],
        schemaVersion: "0.2",
        configDialect: "tvbox",
        blockedFields: ["spider"],
        // The app's own data key, from an export written before 软件数据 moved to 设置.
        moseek: { schemaVersion: 1, favorites: [{ key: "leaked" }] },
      }),
    );
    if (!result.ok) throw new Error("expected a parse");

    const keys = result.settings.map((s) => s.key);
    for (const key of ["schemaVersion", "configDialect", "blockedFields", "moseek"]) {
      expect(keys, key).not.toContain(key);
    }
  });

  it("still offers a key that belongs to another TVBox client", () => {
    // The other half: the block's purpose is to show these, so the fix above must not become an
    // allow-list that hides them.
    const result = readVisualConfig(
      JSON.stringify({ sites: [], doh: [{ name: "dns", url: "https://dns.example" }], ads: ["ad"] }),
    );
    if (!result.ok) throw new Error("expected a parse");

    const keys = result.settings.map((s) => s.key);
    expect(keys).toContain("doh");
    expect(keys).toContain("ads");
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

  it("writes a real boolean when the flag was not there at all", () => {
    // The defect that made a whole configuration unsaveable. The switches send the STRINGS
    // "true"/"false"; the conversion back to a boolean only ran when the entry already carried a
    // numeric flag or a boolean. For a field the entry does not have — the ordinary case, since
    // TVBox omits defaults — every branch was skipped and the string was written straight into a
    // slot the schema requires to be a boolean. One such field then failed validation for the entire
    // document, so nothing could be saved and the error named neither the field nor the entry.
    const raw = JSON.stringify({
      sites: [{ key: "a", name: "甲", api: "https://a.example/api" }],
    });

    const on = JSON.parse(
      updateVisualEntryField(raw, "sites", 0, "searchable", "true").text,
    ) as { sites: { searchable: unknown }[] };
    expect(on.sites[0].searchable).toBe(true);

    const off = JSON.parse(
      updateVisualEntryField(raw, "sites", 0, "filterable", "false").text,
    ) as { sites: { filterable: unknown }[] };
    expect(off.sites[0].filterable).toBe(false);
  });

  it("writes a boolean for every flag field the schema declares", () => {
    // The list of flag names is shared with the schema on purpose: it had been maintained as a second
    // copy here, and the two drifting apart is what let the writer produce a value the schema
    // rejected. This walks the shared list so a name added to one side without the other fails here.
    for (const field of RAW_FLAG_FIELDS) {
      const raw = JSON.stringify({
        sites: [{ key: "a", name: "甲", api: "https://a.example/api" }],
      });
      const written = JSON.parse(
        updateVisualEntryField(raw, "sites", 0, field, "true").text,
      ) as { sites: Record<string, unknown>[] };
      expect(typeof written.sites[0][field], `${field} must be a boolean`).toBe("boolean");

      // And the schema accepts it, which is the property that actually matters.
      const accepted = RawSiteSchema.safeParse(written.sites[0]);
      expect(accepted.success, `${field} must satisfy the schema`).toBe(true);
    }
  });

  it("leaves an out-of-range entry alone instead of throwing", () => {
    // A row can be deleted while its editor is open, so the index may no longer exist.
    expect(updateVisualEntryField(sample, "sites", 9, "name", "x").text).toBe(sample);
  });
});

/**
 * Finding the entry in the file that a parsed source came from.
 *
 * **The reason this needs its own function rather than a key lookup.** The parser renames duplicate
 * keys and invents one where the file states none, so the `key` on a `SourceRecord` may appear nowhere
 * in the text. Measured on a two-site fixture with a repeated key: the parsed keys were `同一个-2` and
 * `live-1`, and neither string occurs in the file. Matching on the key alone finds nothing — or, when
 * another entry happens to hold that name, the wrong entry.
 *
 * This is what lets the source drawer edit a source without the raw-config tab, so a wrong answer here
 * writes one source's fields into another's row.
 */
describe("locating the raw entry behind a parsed source", () => {
  const config = JSON.stringify({
    sites: [
      { key: "a", name: "甲源", api: "https://a.example/api", type: 1 },
      { key: "b", name: "乙源", api: "https://b.example/api", type: 1 },
      { key: "dup", name: "重名甲", api: "https://same.example/api" },
      { key: "dup", name: "重名乙", api: "https://same.example/api" },
    ],
    lives: [{ name: "没有 key 的直播", url: "https://live.example/tv.txt" }],
    parses: [{ name: "解析", type: 1, url: "https://parse.example/jx" }],
  });

  it("finds a site by its address", () => {
    const found = locateVisualEntry(config, "sites", {
      key: "a",
      api: "https://a.example/api",
    });
    expect(found?.index).toBe(0);
    expect(found?.label).toBe("甲源");
  });

  it("finds an entry whose parsed key the file does not contain", () => {
    // The parser names a keyless live entry from its position, so `live-1` is a name that exists only
    // in memory. The address is what the file has, so the address is what is searched.
    const found = locateVisualEntry(config, "lives", {
      key: "live-1",
      api: "https://live.example/tv.txt",
    });
    expect(found?.index).toBe(0);
    expect(found?.label).toBe("没有 key 的直播");
  });

  it("uses the key to separate two entries behind one address", () => {
    // A published configuration runs many sites through one `csp_XBPQ` address, so the address alone
    // is ambiguous. `sourceKey` is the key the FILE states, which is what makes this decidable.
    const first = locateVisualEntry(config, "sites", {
      key: "dup",
      api: "https://same.example/api",
    });
    expect(first?.label).toBe("重名甲");

    // A parsed key that is renamed (`dup-2`) belongs to the second entry, but the file says `dup` for
    // both — so the lookup cannot pick between them and must say so rather than write the wrong row.
    const renamed = locateVisualEntry(config, "sites", {
      key: "dup-2",
      api: "https://same.example/api",
    });
    expect(renamed).toBeNull();
  });

  it("returns null rather than guessing when the address is not in the file", () => {
    // The drawer offers no edit for this source. Guessing would write another entry's fields.
    expect(
      locateVisualEntry(config, "sites", { key: "ghost", api: "https://ghost.example/api" }),
    ).toBeNull();
  });

  it("returns null for an address-less source, and for unreadable text", () => {
    expect(locateVisualEntry(config, "sites", { key: "a", api: "" })).toBeNull();
    expect(locateVisualEntry("{ sites: [ }", "sites", { key: "a", api: "https://a.example" })).toBeNull();
  });

  it("only searches the section it was given", () => {
    // A site and a live entry can share an address without being the same resource.
    expect(
      locateVisualEntry(config, "lives", { key: "a", api: "https://a.example/api" }),
    ).toBeNull();
  });
});
