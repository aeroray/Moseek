import { beforeEach, describe, expect, it, vi } from "vitest";

import { updatePercent } from "@/features/update/update-store";

/**
 * `updatePercent` is the one piece of the update store that is pure arithmetic, and it is the piece
 * that lies most easily: a download whose total is unknown has no percentage, and inventing one
 * would claim progress nobody measured.
 */
describe("updatePercent", () => {
  it("reports a percentage when the total is known", () => {
    expect(updatePercent({ downloaded: 50, total: 200 })).toBe(25);
    expect(updatePercent({ downloaded: 200, total: 200 })).toBe(100);
  });

  it("reports nothing when the total is unknown", () => {
    // The server sent no content-length. `null` makes the panel render an indeterminate bar; a
    // number here would be fabricated.
    expect(updatePercent({ downloaded: 50, total: null })).toBeNull();
    expect(updatePercent({ downloaded: 0, total: 0 })).toBeNull();
  });

  it("never exceeds 100 or goes below 0", () => {
    // A server that under-reports its length would otherwise produce 140%, and a chunk arriving
    // before `Started` would produce a negative.
    expect(updatePercent({ downloaded: 300, total: 200 })).toBe(100);
    expect(updatePercent({ downloaded: -5, total: 200 })).toBe(0);
  });
});

describe("update store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("refuses to check outside the desktop runtime and says why", async () => {
    // The browser preview has no updater plugin; calling it would throw. The store explains itself
    // rather than reporting a mysterious failure.
    vi.doMock("@/lib/tauri", () => ({ isTauriRuntime: () => false }));
    const { useUpdateStore } = await import("@/features/update/update-store");

    await useUpdateStore.getState().check();

    expect(useUpdateStore.getState().phase).toBe("error");
    expect(useUpdateStore.getState().error).toContain("桌面应用");
  });

  it("reports a failed check instead of swallowing it", async () => {
    // The user pressed a button and is owed an answer either way.
    vi.doMock("@/lib/tauri", () => ({ isTauriRuntime: () => true }));
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: async () => {
        throw new Error("网络不可达");
      },
    }));
    const { useUpdateStore } = await import("@/features/update/update-store");

    await useUpdateStore.getState().check();

    expect(useUpdateStore.getState().phase).toBe("error");
    expect(useUpdateStore.getState().error).toContain("网络不可达");
  });

  it("distinguishes 'up to date' from 'never checked'", async () => {
    // These are different facts. Conflating them would let the panel claim a result nobody obtained
    // — the same class of mistake as the fabricated page count in the library footer.
    vi.doMock("@/lib/tauri", () => ({ isTauriRuntime: () => true }));
    vi.doMock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));
    const { useUpdateStore } = await import("@/features/update/update-store");

    expect(useUpdateStore.getState().phase).toBe("idle");
    expect(useUpdateStore.getState().upToDate).toBe(false);

    await useUpdateStore.getState().check();

    expect(useUpdateStore.getState().phase).toBe("idle");
    expect(useUpdateStore.getState().upToDate).toBe(true);
  });

  it("surfaces the version and notes the manifest announced", async () => {
    vi.doMock("@/lib/tauri", () => ({ isTauriRuntime: () => true }));
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: async () => ({
        version: "0.2.0",
        body: "## 修复\n\n- 导出按钮",
        date: "2026-10-04T00:00:00Z",
      }),
    }));
    const { useUpdateStore } = await import("@/features/update/update-store");

    await useUpdateStore.getState().check();

    const state = useUpdateStore.getState();
    expect(state.phase).toBe("available");
    expect(state.available?.version).toBe("0.2.0");
    expect(state.available?.notes).toContain("导出按钮");
  });
});
