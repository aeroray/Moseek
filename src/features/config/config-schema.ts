import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().min(1).optional(),
);

export const RawSiteSchema = z
  .object({
    key: optionalText,
    name: optionalText,
    type: z.union([z.number().int(), z.string()]).optional(),
    api: optionalText,
    ext: optionalText,
    jar: optionalText,
    searchable: z.boolean().optional(),
    quickSearch: z.boolean().optional(),
    filterable: z.boolean().optional(),
    categories: z.unknown().optional(),
  })
  .passthrough();

export const RawConfigSchema = z
  .object({
    sites: z.array(RawSiteSchema).default([]),
    lives: z.array(z.unknown()).default([]),
    parses: z.array(z.unknown()).default([]),
  })
  .passthrough();

export type RawSite = z.infer<typeof RawSiteSchema>;
export type RawConfig = z.infer<typeof RawConfigSchema>;
