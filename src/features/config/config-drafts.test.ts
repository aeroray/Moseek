import { describe, expect, it } from "vitest";

import { shouldResetDrafts } from "@/features/config/config-drafts";

describe("configuration draft resets", () => {
  const source = (
    documentId: number | null,
    rawConfig: string,
    configBaseUrl?: string,
  ) => ({ documentId, rawConfig, configBaseUrl });

  it("keeps the fetched import text when only the base URL changes", () => {
    // Reproduces the remote import flow: the fetched text is already in the editor when the
    // base URL is set from the fetched address. Resetting here replaced that text with the
    // document that was already open, so "import" saved a byte-identical copy of it.
    const beforeFetch = source(2, '{"sites":[{"key":"old"}]}');
    const afterFetch = source(2, '{"sites":[{"key":"old"}]}', "https://example.com/tv/x.json");
    expect(shouldResetDrafts(beforeFetch, afterFetch)).toBe(false);
  });

  it("resets when a different document becomes active", () => {
    expect(
      shouldResetDrafts(source(2, '{"a":1}'), source(9, '{"a":1}')),
    ).toBe(true);
  });

  it("resets when the active document content changes", () => {
    // Live-source recovery, base URL repair, and source toggles all rewrite the stored
    // configuration, and the editors must follow.
    expect(
      shouldResetDrafts(source(2, '{"a":1}'), source(2, '{"a":2}')),
    ).toBe(true);
  });

  it("treats the empty startup state as unchanged", () => {
    expect(shouldResetDrafts(source(null, ""), source(null, ""))).toBe(false);
  });
});
