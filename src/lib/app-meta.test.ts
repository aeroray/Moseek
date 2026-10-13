import { describe, expect, it } from "vitest";

import {
  APP_CODE_NAME,
  APP_NAME,
  APP_SLOGAN,
  APP_VERSION,
  formatVersion,
} from "@/lib/app-meta";

/**
 * The product's display facts.
 *
 * These live in one module so that raising a release means changing the version in one place and the
 * surrounding names cannot drift from it. The tests below are about the two things that were wrong
 * before it existed: the `v` prefix, and the English name appearing in the interface.
 */
describe("app meta", () => {
  it("reports the version the build was made from, with no prefix", () => {
    // Read from `package.json` through the Vite literal, so it agrees with what the installer and the
    // update manifest carry. `scripts/sync-version.mjs` keeps those in step.
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(APP_VERSION).not.toMatch(/^v/i);
  });

  it("never adds a v prefix, however the caller spells the input", () => {
    // The prefix was being added at two call sites and removed at none, so the badge read `v1.0.0`
    // while the update banner read `v1.0.1` — the same kind of value spelled two ways.
    expect(formatVersion("1.0.0")).toBe("1.0.0");
    expect(formatVersion("v1.0.0")).toBe("1.0.0");
    expect(formatVersion("V1.0.0")).toBe("1.0.0");
    // A pre-release keeps its suffix; only the prefix is stripped.
    expect(formatVersion("v1.2.0-beta.1")).toBe("1.2.0-beta.1");
  });

  it("defaults to the running version", () => {
    expect(formatVersion()).toBe(APP_VERSION);
  });

  it("keeps the English name out of the Chinese name and slogan", () => {
    // `Moseek` is the repository's name, not the product's. It is shown nowhere in the interface.
    expect(APP_NAME).toBe("拾影");
    expect(APP_SLOGAN).toBe("万千影视，一拾即得");
    expect(APP_CODE_NAME).toBe("Moseek");
    expect(APP_NAME).not.toContain(APP_CODE_NAME);
  });
});
