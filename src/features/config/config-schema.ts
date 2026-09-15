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

const optionalBoolean = z.preprocess((value) => {
  if (value === 0 || value === "0") return false;
  if (value === 1 || value === "1") return true;
  return value;
}, z.boolean().optional());

export const RawSiteSchema = z
  .object({
    id: optionalText,
    key: optionalText,
    name: optionalText,
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
    ext: optionalText,
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
