import { z } from "zod";

const optionalText = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

const optionalConfigText = z.preprocess((value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}, z.string().min(1).optional());

/**
 * The fields a configuration spells as a flag.
 *
 * Exported because three places need the same list: the schema below (which must accept the
 * spellings a real file uses), the visual editor (which decides by name to render a switch, since a
 * 0/1 value alone is ambiguous — `type: 1` is a dialect, not a yes/no), and the repair pass (which
 * coerces a string spelling back to a real boolean). They were separate copies, and the editor's
 * copy is what wrote `"true"` into one of these slots and made a whole document unsaveable.
 */
export const RAW_FLAG_FIELDS = [
  "nsfw",
  "status",
  "searchable",
  "quickSearch",
  "filterable",
] as const;

export const rawFlagFields: ReadonlySet<string> = new Set(RAW_FLAG_FIELDS);

/**
 * A field TVBox spells as a flag.
 *
 * Real configurations write these five ways — `true`, `false`, `1`, `0`, and the strings `"true"` /
 * `"false"` — and the schema used to accept only the first four. A single `"true"` anywhere then
 * failed validation for the ENTIRE document, so the whole configuration became unsaveable with
 * "Invalid input: expected boolean, received string" and nothing naming the field or the entry.
 *
 * Accepting the string spellings is the right fix rather than tightening the writer: these keys are
 * booleans by meaning, a config in the wild is not ours to reject, and refusing one is how a user
 * ends up unable to save their own file. Anything else is still rejected, so a genuine mistake is
 * still reported.
 */
const optionalBoolean = z.preprocess((value) => {
  if (value === 0 || value === "0" || value === "false") return false;
  if (value === 1 || value === "1" || value === "true") return true;
  return value;
}, z.boolean().optional());

export const RawSiteSchema = z
  .object({
    id: optionalText,
    key: optionalText,
    name: optionalText,
    scriptArchiveId: z.union([z.number().int(), z.string()]).optional(),
    type: z.union([z.number().int(), z.string()]).optional(),
    api: optionalText,
    logo: optionalText,
    desc: optionalText,
    description: optionalText,
    nsfw: optionalBoolean,
    status: optionalBoolean,
    ext: optionalConfigText,
    extra: optionalConfigText,
    jar: optionalText,
    epg: optionalText,
    searchable: optionalBoolean,
    quickSearch: optionalBoolean,
    filterable: optionalBoolean,
    categories: z.unknown().optional(),
  })
  .passthrough();

export const RawLiveSchema = z
  .object({
    id: optionalText,
    key: optionalText,
    name: optionalText,
    type: z.union([z.number().int(), z.string()]).optional(),
    url: optionalText,
    source: optionalText,
    api: optionalText,
    logo: optionalText,
    status: optionalBoolean,
    // Live `ext` is an object in the wild (`{"sp":"Huya"}`), exactly like site `ext`, so it
    // has to be coerced rather than rejected. Treating it as plain text made one such entry
    // fail validation for the whole configuration.
    ext: optionalConfigText,
    epg: optionalText,
  })
  .passthrough();

export const RawConfigSchema = z
  .object({
    sites: z.array(RawSiteSchema).default([]),
    data: z.array(RawSiteSchema).optional(),
    lives: z.array(RawLiveSchema).default([]),
    parses: z.array(z.unknown()).default([]),
  })
  .passthrough();

export type RawSite = z.infer<typeof RawSiteSchema>;
export type RawLive = z.infer<typeof RawLiveSchema>;
export type RawConfig = z.infer<typeof RawConfigSchema>;
