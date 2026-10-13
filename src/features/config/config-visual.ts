import JSON5 from "json5";

import { EXPORT_EXTRAS_KEY } from "@/features/config/config-extras";
import { rawFlagFields } from "@/features/config/config-schema";

/**
 * Reading a configuration into a model, and editing one entry of it in place.
 *
 * The raw text stays the source of truth — it is what is stored, exported and parsed — so every
 * operation here is a pure function from text to text. That keeps whatever reads the file and
 * whatever writes it looking at the same document, and means no caller owns the content.
 *
 * The 原始配置 tab is gone: a source is edited from the drawer it is opened in, which locates the
 * entry behind the parsed source (`locateVisualEntry`) and writes one field back into the text
 * (`updateVisualEntryField`). `readVisualConfig` is what makes that possible — it names each entry
 * so a row can be recognised, because 340 entries in a JSON array are unreadable while the same 340
 * as a list of named rows are not.
 */

/**
 * The arrays whose entries are things a user manages individually.
 *
 * All three are 必需: the library reads `sites`, the live workspace reads `lives`, and the playback
 * fallback reads `parses`. A configuration missing one of them still imports — the others keep
 * working — but the feature that reads it has nothing to show, which is why the editor labels them
 * rather than leaving the user to discover it.
 */
export const visualSections = [
  { key: "sites", title: "影视源", hint: "必需。点播接口，提供搜索、分类与播放地址。" },
  { key: "lives", title: "直播源", hint: "必需。频道列表，提供直播与节目单。" },
  { key: "parses", title: "解析服务", hint: "必需。把播放页地址解析成可直接播放的地址。" },
] as const;

export type VisualSectionKey = (typeof visualSections)[number]["key"];

/** One editable field on an entry, in the order a user should read them. */
export interface VisualField {
  name: string;
  value: string;
  /** `text` for ordinary values, `json` for a nested object or array, `flag` for a boolean. */
  kind: "text" | "json" | "flag" | "number";
  /** Whether clearing it is meaningful. A required field is one the entry cannot work without. */
  required: boolean;
}

export interface VisualEntry {
  /** Position in the array. Stable for the lifetime of one parse, and what operations address. */
  index: number;
  /** What the entry is called. Falls back to the identity when a name is missing. */
  label: string;
  /**
   * The entry's address, used for searching.
   *
   * No longer shown on the row — 340 lines of `https://…/api.php/provide/vod` distinguish nothing,
   * and the row shows the test result instead — but it is still what a user types when they are
   * looking for a particular source, so it stays searchable.
   */
  summary: string;
  /**
   * The key the parser gives this entry, when the file states one.
   *
   * The join between a row and its parsed source: the editor edits text while test results live on
   * parsed records, and the key is what both sides agree on. A live entry with no `key` is given one
   * by the parser from its position, which the editor cannot know, so it stays null and the row
   * simply shows no test result rather than guessing at one.
   */
  sourceKey: string | null;
  fields: VisualField[];
  /** Fields present in the file that the editor does not offer as rows. */
  extraFieldCount: number;
}

export interface VisualSection {
  key: VisualSectionKey;
  title: string;
  hint: string;
  entries: VisualEntry[];
  /** Present in the file but empty, so the section is still shown with an explanation. */
  present: boolean;
}

/** A top-level value that is not one of the entry arrays. */
export interface VisualSetting {
  key: string;
  value: string;
  kind: "text" | "json";
}

export interface VisualConfig {
  ok: true;
  sections: VisualSection[];
  settings: VisualSetting[];
  /** Top-level keys the editor does not model, kept so nothing is silently lost. */
  unknownKeys: string[];
}

export interface VisualConfigError {
  ok: false;
  message: string;
}

export type VisualConfigResult = VisualConfig | VisualConfigError;

/**
 * The fields offered per section, and which of them an entry needs.
 *
 * **"Required" here means one thing only: without it the entry cannot work.** It is not "the parser
 * will complain" and not "the app prefers it" — both were true of fields marked required before, and
 * marking those as 必需 would tell the user to keep a field that changes nothing. Each entry below is
 * settled against the parser rather than by intuition:
 *
 *  - `sites.key` / `sites.name` are **optional**: the parser falls back to `id`, then numbers the
 *    entry (`invalid-N`), and names it `未命名源 N`. The source still loads and still plays; it is
 *    just harder to recognise. (`key` being absent does mean the source reads as `invalid` to
 *    `classifySource`, which is why leaving it out is worth warning about — but it is a quality
 *    problem, not a broken entry, and the two must not be labelled the same.)
 *  - `sites.api` is required: it is the address everything else is fetched from.
 *  - `lives.url` is required for the same reason; `lives.name` is not — the parser names it
 *    `直播源 N`.
 *  - `parses.url` is required; `parses.type` is not, because the resolver reads the address.
 */
const sectionFields: Record<VisualSectionKey, { name: string; required: boolean }[]> = {
  sites: [
    { name: "key", required: false },
    { name: "name", required: false },
    { name: "api", required: true },
    { name: "type", required: false },
    { name: "ext", required: false },
    { name: "jar", required: false },
    { name: "searchable", required: false },
    { name: "filterable", required: false },
  ],
  lives: [
    { name: "name", required: false },
    { name: "url", required: true },
    { name: "key", required: false },
    { name: "type", required: false },
    { name: "epg", required: false },
    { name: "logo", required: false },
    { name: "group", required: false },
  ],
  parses: [
    { name: "name", required: false },
    { name: "type", required: false },
    { name: "url", required: true },
    { name: "ext", required: false },
  ],
};

/** The address field per section, used for the one-line summary. */
const summaryField: Record<VisualSectionKey, string> = {
  sites: "api",
  lives: "url",
  parses: "url",
};

/**
 * Top-level keys that are not configuration and must never be offered as 其他设置 rows.
 *
 * **The block exists for keys belonging to other TVBox clients** — `doh`, `ads`, `ijk`, `wallpaper` —
 * so a user can see and clear them. The keys listed here are different: they are either this app's own
 * data or bookkeeping the parser writes itself, and showing them made the block say something false.
 *
 *  - `moseek` carried favourites and the theme. Exported files no longer write it and import strips it,
 *    but a document that already contains it must not show the user's 收藏 under a heading that says
 *    "TVBox 客户端的设置".
 *  - `schemaVersion`, `configDialect` and `blockedFields` are **written by the parser** — see
 *    `normalizedConfig` in config-parser.ts. They describe the document to other tools. Listing them
 *    as editable "TVBox settings" offered the user a text box for `schemaVersion` whose value is
 *    regenerated on every write, so editing it did nothing and the heading misdescribed it.
 *
 * The count differed between documents, which is how the user noticed: a freshly imported document had
 * a 其他设置 block while the same configuration before re-import did not.
 *
 * This is deliberately a deny-list rather than an allow-list: the block's purpose is to show keys
 * belonging to other clients, and an allow-list would hide exactly those.
 */
const nonConfigurationKeys = new Set<string>([
  EXPORT_EXTRAS_KEY,
  "schemaVersion",
  "configDialect",
  "blockedFields",
]);

const knownSectionKeys = new Set<string>(visualSections.map((section) => section.key));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Renders a value as the text a user edits. */
function fieldText(value: unknown, kind?: VisualField["kind"]): string {
  if (value === undefined || value === null) return "";
  // A 0/1 flag is shown as a switch, so its text form is the boolean the switch reads.
  if (kind === "flag") {
    if (value === 0 || value === "0" || value === false) return "false";
    if (value === 1 || value === "1" || value === true) return "true";
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

/**
 * The fields a configuration spells as a flag.
 *
 * A 0/1 value is ambiguous on its own: `type: 1` is a dialect identifier, `timeout: 30` is seconds,
 * and `searchable: 1` is a yes/no. Deciding by the value alone made every `type: 1` source render a
 * switch for its type, and flipping that switch would have written 0 — silently changing the
 * source's dialect. The field name is what carries the meaning, so the decision is made by name.
 *
 * The list itself lives in `config-schema.ts`, next to the schema that has to accept these fields'
 * spellings. Keeping a second copy here is what let the editor write `"true"` as a string into a
 * boolean slot while the schema rejected the whole document for it.
 */
const flagFields = rawFlagFields;

function fieldKind(name: string, value: unknown): VisualField["kind"] {
  if (typeof value === "boolean") return "flag";
  if (flagFields.has(name)) return "flag";
  if (typeof value === "number") return "number";
  if (isPlainObject(value) || Array.isArray(value)) return "json";
  return "text";
}

/** The fields the configuration spells as 0/1 rather than true/false. */
function usesNumericFlag(value: unknown): boolean {
  return value === 0 || value === 1;
}

/**
 * Reads a configuration into the visual model.
 *
 * Parsing uses JSON5 so a file with trailing commas or unquoted keys still opens — the same
 * tolerance the import path has. A file that cannot be parsed at all is reported rather than
 * silently shown as empty, because "nothing here" and "I cannot read this" need different actions.
 */
export function readVisualConfig(rawText: string): VisualConfigResult {
  if (!rawText.trim()) return { ok: false, message: "配置为空。" };
  let parsed: unknown;
  try {
    parsed = JSON5.parse(rawText);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "配置无法解析。",
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, message: "配置的顶层必须是一个对象。" };
  }

  const sections: VisualSection[] = visualSections.map((section) => {
    const raw = parsed[section.key];
    const list = Array.isArray(raw) ? raw : [];
    const fields = sectionFields[section.key];
    const entries: VisualEntry[] = list.map((item, index) => {
      const record = isPlainObject(item) ? item : {};
      const offered = new Set(fields.map((field) => field.name));
      const label =
        fieldText(record.name) || fieldText(record.key) || `第 ${index + 1} 项`;
      return {
        index,
        label,
        summary: fieldText(record[summaryField[section.key]]),
        // Only a key the file actually states. The parser invents one for a live entry without a
        // `key` (from its position), and the editor cannot reproduce that rule, so a missing key
        // stays null rather than being guessed at and matching the wrong row.
        sourceKey: typeof record.key === "string" && record.key ? record.key : null,
        fields: fields.map((field) => {
          const kind = fieldKind(field.name, record[field.name]);
          return {
            name: field.name,
            value: fieldText(record[field.name], kind),
            kind,
            required: field.required,
          };
        }),
        extraFieldCount: Object.keys(record).filter((key) => !offered.has(key)).length,
      };
    });
    return {
      key: section.key,
      title: section.title,
      hint: section.hint,
      entries,
      // Distinguishes "the file has no such section" from "the section is empty": the first is
      // nothing to show, the second is a place a user can add to.
      present: Array.isArray(raw),
    };
  });

  const settings: VisualSetting[] = [];
  const unknownKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (knownSectionKeys.has(key)) continue;
    // This app's own data key is not a configuration setting. See `nonConfigurationKeys`.
    if (nonConfigurationKeys.has(key)) continue;
    if (isPlainObject(value) || Array.isArray(value)) {
      // Collections of rules, hosts and proxies are configuration a user edits as text, not as
      // rows: there is no useful per-item form for `doh` or `ads` that would not be a text box.
      settings.push({ key, value: JSON.stringify(value, null, 2), kind: "json" });
      continue;
    }
    if (value === undefined || value === null) continue;
    settings.push({ key, value: fieldText(value), kind: "text" });
    void unknownKeys;
  }

  return { ok: true, sections, settings, unknownKeys };
}

/** Serialises a configuration object the way the rest of the application stores it. */
function serialize(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}

/**
 * Applies a change to one entry.
 *
 * Every operation parses, edits and re-serialises. Re-serialising normalises formatting, which is a
 * real side effect: comments and the original layout are not preserved. That is what the note beside
 * an edited source is for, and why the file is still readable and editable as text for anyone who
 * cares about its exact spelling.
 */
function editEntry(
  rawText: string,
  section: VisualSectionKey,
  index: number,
  mutate: (entry: Record<string, unknown>) => void,
): string {
  const parsed = JSON5.parse(rawText) as Record<string, unknown>;
  const list = parsed[section];
  if (!Array.isArray(list) || index < 0 || index >= list.length) return rawText;
  const entry = isPlainObject(list[index]) ? (list[index] as Record<string, unknown>) : {};
  mutate(entry);
  list[index] = entry;
  parsed[section] = list;
  return serialize(parsed);
}

/**
 * Finds the entry in the raw text that a parsed source came from.
 *
 * **A parsed `source.key` is not enough on its own, and that is the whole reason this exists.** The
 * parser renames duplicate keys (`极速资源` → `极速资源-2`) and invents one for an entry that states
 * none (`live-1` from its position) — measured on a two-site fixture with a repeated key: the keys
 * `同一个-2` and `live-1` appear nowhere in the file. Matching on the key alone would either fail to
 * find the entry or, worse, find a *different* one that happens to hold the renamed key.
 *
 * So the address is the primary identity, because it is what the file really contains and what makes
 * two entries different. The key is a tie-breaker for the case the address cannot separate: two live
 * entries behind one playlist address, distinguished only by their names.
 *
 * Returns `null` rather than guessing. A source the file cannot be located in is a source the drawer
 * must not offer to edit — the alternative is writing the wrong entry's fields.
 */
export function locateVisualEntry(
  rawText: string,
  section: VisualSectionKey,
  source: { key: string; api?: string },
): VisualEntry | null {
  const config = readVisualConfig(rawText);
  if (!config.ok) return null;
  const target = config.sections.find((item) => item.key === section);
  if (!target) return null;

  const address = (source.api ?? "").trim();
  const candidates = address
    ? target.entries.filter(
        (entry) =>
          (entry.fields.find((field) => field.name === summaryField[section])?.value ?? "").trim() ===
          address,
      )
    : [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // More than one entry shares the address, so the key decides. A key the file states is matched
  // exactly; the parser's renamed form is not searched for, because it is not in the file and
  // matching it would pick the wrong row of a duplicate pair.
  const byKey = candidates.find((entry) => entry.sourceKey === source.key);
  return byKey ?? null;
}

/**
 * Sets one field on an entry.
 *
 * An emptied required field is refused rather than written as `""`: the entry would stop working and
 * the reason would be invisible in the list. An emptied optional field is removed from the entry
 * entirely, so the file does not accumulate `"ext": ""` on every edit.
 */
export function updateVisualEntryField(
  rawText: string,
  section: VisualSectionKey,
  index: number,
  field: string,
  value: string,
): { text: string; error: string | null } {
  const definition = sectionFields[section].find((item) => item.name === field);
  const trimmed = value.trim();
  if (definition?.required && !trimmed) {
    return { text: rawText, error: `${field} 是必填字段，不能留空。` };
  }
  const text = editEntry(rawText, section, index, (entry) => {
    if (!trimmed) {
      delete entry[field];
      return;
    }
    const previous = entry[field];
    if (typeof previous === "number" && Number.isFinite(Number(trimmed))) {
      entry[field] = Number(trimmed);
      return;
    }
    // A 0/1 flag stays 0/1 and a boolean stays a boolean. Writing the string "false" into a field
    // the parser expects to be a boolean is the kind of silent breakage a visual editor must not
    // introduce — the file would look right and the source would stop working.
    if (previous !== undefined && usesNumericFlag(previous)) {
      entry[field] = trimmed === "true" || trimmed === "1" ? 1 : 0;
      return;
    }
    if (typeof previous === "boolean") {
      entry[field] = trimmed === "true" || trimmed === "1";
      return;
    }
    // A JSON field keeps its shape: writing a string where an object belongs would change what the
    // parser sees and silently break the entry. Checked before the flag rule below, so a field that
    // happens to be named like a flag but holds an object is never collapsed to a boolean.
    if (isPlainObject(previous) || Array.isArray(previous)) {
      try {
        entry[field] = JSON5.parse(trimmed);
      } catch {
        entry[field] = trimmed;
      }
      return;
    }
    // A flag field the entry does NOT have yet.
    //
    // This is the case that broke saving. The switches in the visual editor send "true"/"false" for
    // these five field names, and when the key was absent every branch above was skipped, so the
    // string was written straight into a slot the schema requires to be a boolean — the document
    // then failed validation and could not be saved at all. The field name is what marks it as a
    // flag, which is the same rule `fieldKind` uses to decide to render a switch in the first place,
    // so the two cannot disagree about which fields these are.
    if (flagFields.has(field)) {
      entry[field] = trimmed === "true" || trimmed === "1";
      return;
    }
    entry[field] = trimmed;
  });
  return { text, error: null };
}
