import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

import { parseConfigText } from "@/features/config/config-parser";

/**
 * Runs the parser against a real exported file, when one is pointed at by `MSEEK_ROUNDTRIP_FILE`.
 *
 * **Why an env-gated test rather than a fixture.** The defect being fixed is a round-trip failure:
 * Moseek's own export could not be read back by Moseek. A hand-written fixture would encode my
 * assumption about what the export looks like, and an assumption is what produced the bug. The real
 * file is 88 KB of the user's own configuration and does not belong in the repository, so the test
 * runs only when the path is supplied and is skipped otherwise.
 *
 * Usage: `MSEEK_ROUNDTRIP_FILE=<path> npx vitest run src/features/config/config-roundtrip-real.test.ts`
 */
const file = process.env.MSEEK_ROUNDTRIP_FILE;

/** `ParseResult` reports failure through `issues`, not a separate field. */
function failureDetail(result: ReturnType<typeof parseConfigText>) {
  return result.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.path}：${issue.message}`)
    .join("；");
}

describe.skipIf(!file || !existsSync(file))("a real exported configuration", () => {
  it("parses back into the app that wrote it", () => {
    const text = readFileSync(file as string, "utf8");
    const result = parseConfigText(text);

    // The failure this test exists for. Before the fix, the first error read:
    //   sites.0.scriptArchiveId：Invalid input
    // and nothing in the message said the file was written by this same application.
    expect(result.ok, failureDetail(result)).toBe(true);

    // The counts the export header claims, so a file that parses into fewer entries is caught.
    const raw = JSON.parse(text) as { sites?: unknown[]; lives?: unknown[]; parses?: unknown[] };
    expect(result.sources.filter((s) => s.sourceType !== "live")).toHaveLength(
      raw.sites?.length ?? 0,
    );
    expect(result.sources.filter((s) => s.sourceType === "live")).toHaveLength(
      raw.lives?.length ?? 0,
    );
    expect(result.parseServices).toHaveLength(raw.parses?.length ?? 0);

    // Every entry must survive with a key, or the list renders blank rows.
    for (const source of result.sources) {
      expect(source.key, "每个源都必须有 key").toBeTruthy();
    }

    // **An entry with no address is kept and named, not dropped.** The file carries one real example:
    // `live-15`, named 直播源 14, whose `api` and `url` are both empty. It is the user's data, so the
    // parser reports it as unsupported rather than deleting it — and the app can only do that if the
    // entry arrives. This assertion is what distinguishes "kept and explained" from "silently gone".
    const addressless = result.sources.filter((source) => !source.api);
    for (const source of addressless) {
      expect(source.capability, `${source.key} 无地址时应标记为不可用`).not.toBe("supported");
      expect(source.capabilityNote, `${source.key} 必须说明原因`).toBeTruthy();
    }

    // And the converse: anything the parser calls usable must have an address to use.
    for (const source of result.sources.filter((s) => s.capability === "supported")) {
      expect(source.api, `标记为可用的源 ${source.key} 必须有地址`).toBeTruthy();
    }
  });

  it("survives a second round trip unchanged in the parts that matter", () => {
    // Export → import → export. The second export is the one the user would send to someone else, so
    // it has to parse too — a fix that only handled the first read would leave the next one broken.
    const text = readFileSync(file as string, "utf8");
    const first = parseConfigText(text);
    expect(first.ok, failureDetail(first)).toBe(true);

    const second = parseConfigText(first.normalizedConfig);
    expect(second.ok, failureDetail(second)).toBe(true);

    // Same entries, by key, in both.
    expect(second.sources.map((s) => s.key).sort()).toEqual(
      first.sources.map((s) => s.key).sort(),
    );
  });
});
