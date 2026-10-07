import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { removeSources, setSourceEnabled, type StoredConfigDocument } from "@/lib/tauri";
import type { SourceRecord } from "@/types/moseek";

vi.mock("@/lib/tauri", () => ({ removeSources: vi.fn(), setSourceEnabled: vi.fn() }));
const source = (enabled: boolean): SourceRecord => ({ key: "same", name: "源", sourceType: "cms", api: "https://example.com", searchable: true,
  filterable: true, capability: "supported", capabilityNote: "", enabled, lastCheckedAt: "", requestCount: 0 });
const document = (id: number, enabled: boolean): StoredConfigDocument => ({ id, name: "中心配置", rawConfig: "{}", normalizedConfig: "{}", sources: [source(enabled)],
  sourceCount: 1, liveCount: 0, importedAt: "2026-10-07T00:00:00Z" });

describe("configuration operation ownership", () => {
  beforeEach(() => { vi.clearAllMocks(); useAppStore.getState().setConfigDocument(document(1, true), true); });
  it("does not reactivate an old document when its removal finishes late", async () => {
    let finish!: (value: StoredConfigDocument) => void;
    vi.mocked(removeSources).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const removing = useAppStore.getState().removeSources(["same"]);
    useAppStore.getState().setConfigDocument(document(2, false), true);
    finish(document(1, true));
    await removing;
    expect(useAppStore.getState().activeConfigId).toBe(2);
    expect(useAppStore.getState().sources[0].enabled).toBe(false);
  });
  it("never applies a queued toggle to another document with the same source key", async () => {
    let finish!: (value: StoredConfigDocument) => void;
    vi.mocked(setSourceEnabled).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = useAppStore.getState().toggleSource("same");
    const second = useAppStore.getState().toggleSource("same");
    await vi.waitFor(() => expect(setSourceEnabled).toHaveBeenCalledOnce());
    useAppStore.getState().setConfigDocument(document(2, false), true);
    finish(document(1, false));
    await Promise.all([first, second]);
    expect(setSourceEnabled).toHaveBeenCalledOnce();
    expect(useAppStore.getState().activeConfigId).toBe(2);
    expect(useAppStore.getState().sources[0].enabled).toBe(false);
  });
  it("keeps one in-memory snapshot and one summary after repeated replacements", () => {
    for (let id = 2; id < 100; id += 1) useAppStore.getState().setConfigDocument(document(id, true), true);
    expect(Object.keys(useAppStore.getState().configDocumentCache)).toHaveLength(1);
    expect(useAppStore.getState().configDocuments).toHaveLength(1);
  });
});
