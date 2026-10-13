import { z } from "zod";

/**
 * The three ways a configuration says "this field has no value": it omits the key, it writes an empty
 * string, or it writes `null`.
 *
 * **`null` and absent are different to Zod, and JSON treats them as the same idea.** Every optional
 * field below used to accept only the first two, so a file that spelled a value `null` failed
 * validation for the whole document. That is not a hypothetical: Moseek's own export serialises the
 * source record, so it wrote `"scriptArchiveId": null` on all 39 entries, and re-importing the file
 * produced `解析失败（字段 sites.0.scriptArchiveId）：Invalid input` — the app could not read what it
 * had just written. The same shape appears in hand-edited files and in other clients' exports, which
 * is why this is handled once here rather than field by field.
 *
 * Normalising to `undefined` rather than widening each union keeps one spelling of "no value"
 * downstream, where callers already branch on `undefined`.
 */
const absentWhenNull = (value: unknown) => (value === null ? undefined : value);

const optionalText = z.preprocess((value) => {
  const unwrapped = absentWhenNull(value);
  if (typeof unwrapped !== "string") return unwrapped;
  const trimmed = unwrapped.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

const optionalConfigText = z.preprocess((value) => {
  const unwrapped = absentWhenNull(value);
  if (typeof unwrapped === "string") {
    const trimmed = unwrapped.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof unwrapped === "object") {
    return JSON.stringify(unwrapped);
  }
  return unwrapped;
}, z.string().min(1).optional());

/**
 * A number-or-string field that may also be absent or `null`.
 *
 * `type` is a TVBox dialect number but some files write it as a string, and `scriptArchiveId` is the
 * leftover of the removed script runtime — its type allows both and its value is now always null.
 */
const optionalNumberOrText = z.preprocess(
  absentWhenNull,
  z.union([z.number().int(), z.string()]).optional(),
);

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
  const unwrapped = absentWhenNull(value);
  if (unwrapped === 0 || unwrapped === "0" || unwrapped === "false") return false;
  if (unwrapped === 1 || unwrapped === "1" || unwrapped === "true") return true;
  return unwrapped;
}, z.boolean().optional());

export const RawSiteSchema = z
  .object({
    id: optionalText,
    key: optionalText,
    name: optionalText,
    scriptArchiveId: optionalNumberOrText,
    type: optionalNumberOrText,
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

/**
 * A live source's `channels` lines.
 *
 * TVBox lets one live entry carry several selectable lines instead of a single `url`:
 *
 *     {"channels": [{"name": "live", "urls": ["proxy://do=live&type=txt&ext=<base64>"]}],
 *      "group": "redirect"}
 *
 * Moseek read only `url`/`source`/`api`, so such an entry arrived with no address at all and was
 * reported as `直播源缺少 name 或 url/api 字段` — the source was in the file and working in other
 * clients, and here it was an empty row. Measured on the user's own configuration: the entry is
 * `live-15`/`live-14`, named `直播源 14` by the positional fallback, `api: ""`.
 *
 * **`z.unknown()` on the whole field, not a modelled array.** This part of the format is not one Moseek
 * uses for anything except reading an address, and modelling it means every unexpected shape — a
 * string, a null element, `urls` as a number — fails validation for the ENTIRE document. The parser
 * walks it defensively instead, which is the same treatment `parses` already gets. An earlier version
 * of this field did model the array and a `"channels": "not-an-array"` entry took the whole
 * configuration down.
 */
const optionalChannels = z.preprocess(absentWhenNull, z.unknown().optional());

export const RawLiveSchema = z
  .object({
    id: optionalText,
    key: optionalText,
    name: optionalText,
    type: optionalNumberOrText,
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
    channels: optionalChannels,
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
