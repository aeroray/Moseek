import { describe, expect, it } from "vitest";

import { getMockCatalog, getMockDetail } from "@/lib/mock-vod-data";

describe("mock CMS catalog adapter", () => {
  it("paginates a source catalog and exposes categories", () => {
    const catalog = getMockCatalog("clzy", "", "all", 1, 1);

    expect(catalog.total).toBe(2);
    expect(catalog.pageCount).toBe(2);
    expect(catalog.items).toHaveLength(1);
    expect(catalog.categories.map((item) => item.name)).toEqual(
      expect.arrayContaining(["剧情", "悬疑"]),
    );
  });

  it("filters by query and category", () => {
    const catalog = getMockCatalog("clzy", "海岸", "documentary", 1, 8);

    expect(catalog.total).toBe(1);
    expect(catalog.items[0]?.name).toBe("海岸线之外");
  });

  it("returns detail with playable lines and episodes", () => {
    const item = getMockDetail("fog-harbor-letter");

    expect(item?.playLines).toHaveLength(2);
    expect(item?.playLines[0]?.episodes).toHaveLength(12);
    expect(item?.playLines[0]?.episodes[0]?.url).toContain("m3u8");
  });
});
