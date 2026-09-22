import JSON5 from "json5";

/**
 * The visual editor's model of a configuration.
 *
 * The raw text stays the source of truth — it is what is stored, exported and parsed — so every
 * operation here is a pure function from text to text. That keeps the visual editor and the code
 * editor looking at the same document, and means a user can switch between them without either one
 * owning the content.
 *
 * A configuration is a handful of arrays of entries plus a set of scalar settings. The arrays are
 * what a user manages one item at a time; the settings are things like the wallpaper address or the
 * ad-blocking rules, which are values rather than collections. Treating those two shapes differently
 * is the whole reason a visual editor is easier than text: 340 entries in a JSON array are
 * unreadable, while the same 340 as a list of named rows are not.
 */

/** The arrays whose entries are things a user manages individually. */
export const visualSections = [
  { key: "sites", title: "影视源", hint: "点播接口，提供搜索、分类与播放地址。" },
  { key: "lives", title: "直播源", hint: "频道列表，提供直播与节目单。" },
  { key: "parses", title: "解析服务", hint: "把播放页地址解析成可直接播放的地址。" },
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

/** The fields offered per section, and which of them an entry needs. */
const sectionFields: Record<VisualSectionKey, { name: string; required: boolean }[]> = {
  sites: [
    { name: "key", required: true },
    { name: "name", required: true },
    { name: "api", required: true },
    { name: "type", required: false },
    { name: "ext", required: false },
    { name: "jar", required: false },
    { name: "searchable", required: false },
    { name: "filterable", required: false },
  ],
  lives: [
    { name: "name", required: true },
    { name: "url", required: true },
    { name: "key", required: false },
    { name: "type", required: false },
    { name: "epg", required: false },
    { name: "logo", required: false },
    { name: "group", required: false },
  ],
  parses: [
    { name: "name", required: true },
    { name: "type", required: true },
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
 */
const flagFields = new Set([
  "searchable",
  "quickSearch",
  "filterable",
  "status",
  "nsfw",
]);

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
 * real side effect: comments and the original layout are not preserved. That is why the visual mode
 * says so once, and why the code editor exists — a user who cares about the exact text is the user
 * the advanced mode is for.
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
 * Removes one entry.
 *
 * Deleting here and deleting from the source list are different operations on purpose: the list
 * removes a *parsed source*, which also rewrites the normalised snapshot and the stored record,
 * while this edits the configuration text. A user who wants the source gone from the application
 * uses the list; a user tidying the file uses this.
 */
export function removeVisualEntry(
  rawText: string,
  section: VisualSectionKey,
  index: number,
): string {
  const parsed = JSON5.parse(rawText) as Record<string, unknown>;
  const list = parsed[section];
  if (!Array.isArray(list) || index < 0 || index >= list.length) return rawText;
  list.splice(index, 1);
  parsed[section] = list;
  return serialize(parsed);
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
    // parser sees and silently break the entry.
    if (isPlainObject(previous) || Array.isArray(previous)) {
      try {
        entry[field] = JSON5.parse(trimmed);
      } catch {
        entry[field] = trimmed;
      }
      return;
    }
    entry[field] = trimmed;
  });
  return { text, error: null };
}

/** Adds a new entry to a section, with the minimum the section needs. */
export function addVisualEntry(
  rawText: string,
  section: VisualSectionKey,
): string {
  const parsed = JSON5.parse(rawText) as Record<string, unknown>;
  const list = Array.isArray(parsed[section]) ? (parsed[section] as unknown[]) : [];
  const entry: Record<string, unknown> = {};
  for (const field of sectionFields[section]) {
    if (!field.required) continue;
    // A placeholder rather than an empty string: the entry is visibly unfinished in the list, and
    // the required-field rule means it cannot be saved blank either.
    entry[field.name] = "";
  }
  list.push(entry);
  parsed[section] = list;
  return serialize(parsed);
}

/** Sets one top-level setting. */
export function updateVisualSetting(
  rawText: string,
  key: string,
  value: string,
): { text: string; error: string | null } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON5.parse(rawText) as Record<string, unknown>;
  } catch (error) {
    return {
      text: rawText,
      error: error instanceof Error ? error.message : "配置无法解析。",
    };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    delete parsed[key];
    return { text: serialize(parsed), error: null };
  }
  const previous = parsed[key];
  if (isPlainObject(previous) || Array.isArray(previous)) {
    try {
      parsed[key] = JSON5.parse(trimmed);
    } catch {
      return { text: rawText, error: `${key} 需要是有效的 JSON。` };
    }
    return { text: serialize(parsed), error: null };
  }
  parsed[key] = previous !== undefined && typeof previous === "number" && Number.isFinite(Number(trimmed))
    ? Number(trimmed)
    : trimmed;
  return { text: serialize(parsed), error: null };
}

/**
 * Removes one top-level setting.
 *
 * Clearing a setting's box already removes it (see `updateVisualSetting`), but that fact is
 * invisible: an empty field reads as "no value" rather than "this key is gone". A row-level delete
 * says what it does.
 */
export function removeVisualSetting(rawText: string, key: string): string {
  return removeVisualSettings(rawText, [key]);
}

/**
 * Removes several top-level settings at once.
 *
 * One parse and one serialisation for the whole set, so clearing eleven keys cannot reorder or
 * reformat the document eleven times over. A key that is not present is skipped rather than treated
 * as an error, so the caller can pass whatever the section is showing.
 */
export function removeVisualSettings(rawText: string, keys: readonly string[]): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON5.parse(rawText) as Record<string, unknown>;
  } catch {
    return rawText;
  }
  let removed = false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    delete parsed[key];
    removed = true;
  }
  return removed ? serialize(parsed) : rawText;
}

/**
 * The parser services that repeat an address already listed.
 *
 * The resolver attempts at most `MAX_PARSE_SERVICES` (12) services per playback, in the
 * configuration's own order, so a duplicate occupies one of those places with an attempt that has
 * already been made. Measured on the author's configuration: 75 entries, 57 distinct addresses, and
 * the twelfth usable one sits at position 14 — the later entries are never reached at all.
 *
 * Only the address is compared, because that is what an attempt is: the resolver builds its request
 * from the URL and the method, and across every duplicate group in the real configuration the
 * method, headers and body are identical.
 */
export function findDuplicateParseServices(rawText: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(rawText);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const list = parsed.parses;
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const duplicates: number[] = [];
  list.forEach((item, index) => {
    const record = isPlainObject(item) ? item : {};
    const url = foldAddress(record.url);
    if (!url) return;
    if (seen.has(url)) {
      duplicates.push(index);
      return;
    }
    seen.add(url);
  });
  return duplicates;
}

/** The first entry of each address, dropping the repeats. */
export function dedupeParseServices(rawText: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON5.parse(rawText) as Record<string, unknown>;
  } catch {
    return rawText;
  }
  const list = parsed.parses;
  if (!Array.isArray(list)) return rawText;

  const seen = new Set<string>();
  const kept = list.filter((item) => {
    const record = isPlainObject(item) ? item : {};
    const url = foldAddress(record.url);
    // An entry with no address is kept: it is already its own problem, and dropping it here would
    // make this button quietly delete something the user cannot see a duplicate of.
    if (!url) return true;
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  if (kept.length === list.length) return rawText;
  parsed.parses = kept;
  return serialize(parsed);
}

/** An address folded for comparison: padded and cased differences are the same address. */
function foldAddress(value: unknown): string {
  return fieldText(value).trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * Whether the text holds comments or a layout the visual editor would not preserve.
 *
 * JSON5 allows both, and re-serialising drops them. Telling the user before they edit is the
 * difference between a considered choice and silent loss.
 */
export function hasUnpreservedSyntax(rawText: string): boolean {
  // A comment marker outside a string. Good enough for a warning: the cost of a false positive is
  // one sentence, and the cost of a false negative is lost text.
  let inString = false;
  let escaped = false;
  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "/" && (rawText[index + 1] === "/" || rawText[index + 1] === "*")) {
      return true;
    }
  }
  return false;
}

/**
 * Decides whether the edited text may replace the stored configuration.
 *
 * Extracted from the page so the rule is testable on its own. The editor that can produce invalid
 * text is CodeMirror, which a jsdom test cannot type into, so a guard living only in the component
 * would have no coverage — and this is the guard that stops an unreadable file from replacing a
 * working configuration, which is the worst outcome this screen can produce.
 *
 * There is no separate empty-text branch: `JSON5.parse("")` throws, so the empty case is already
 * covered and a second check would be a line no test could tell from its absence. Measured, not
 * assumed — the mutation that deleted such a check changed no behaviour.
 */
export function canSaveVisualConfig(
  rawText: string,
): { ok: true } | { ok: false; message: string } {
  try {
    JSON5.parse(rawText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "配置无法解析。";
    return {
      ok: false,
      // Naming the syntax error is what makes the refusal actionable: the user is looking at a text
      // editor, and "invalid" alone leaves them to find it.
      message: `配置无法保存，请先修正语法：${detail}`,
    };
  }
  return { ok: true };
}
