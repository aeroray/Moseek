import { describe, expect, it } from "vitest";

import { describeDuplicateMatch } from "@/features/config/config-duplicate";
import type { ConfigDuplicateMatch } from "@/lib/tauri";

const match = (
  overrides: Partial<ConfigDuplicateMatch> = {},
): ConfigDuplicateMatch => ({
  documentId: 2,
  documentName: "配置 2",
  kind: "derived",
  candidateSourceCount: 237,
  documentSourceCount: 187,
  sharedSourceCount: 187,
  ...overrides,
});

describe("duplicate import explanations", () => {
  it("says the content is identical", () => {
    expect(
      describeDuplicateMatch(
        match({ kind: "identical", candidateSourceCount: 187, documentSourceCount: 187 }),
      ),
    ).toContain("内容完全相同");
  });

  it("explains that the stored document is a trimmed copy of the import", () => {
    // The case that motivates the whole check: the user trimmed an imported configuration
    // and is now re-importing the untouched original.
    const message = describeDuplicateMatch(match());
    expect(message).toContain("被裁剪后的版本");
    expect(message).toContain("187 个源全部包含");
    expect(message).toContain("这份共 237 个");
  });

  it("explains that the import is a trimmed copy of the stored document", () => {
    const message = describeDuplicateMatch(
      match({ candidateSourceCount: 187, documentSourceCount: 237, sharedSourceCount: 187 }),
    );
    expect(message).toContain("都已存在于「配置 2」中");
    expect(message).toContain("该配置共 237 个");
  });

  it("explains an equal source count with different content", () => {
    const message = describeDuplicateMatch(
      match({ candidateSourceCount: 187, documentSourceCount: 187, sharedSourceCount: 187 }),
    );
    expect(message).toContain("源完全相同");
    expect(message).toContain("内容有差异");
  });

  it("explains a shared import address", () => {
    expect(
      describeDuplicateMatch(match({ kind: "same-origin" })),
    ).toContain("同一个导入地址");
  });
});
