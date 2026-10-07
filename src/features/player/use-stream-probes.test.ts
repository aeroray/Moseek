import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStreamProbes } from "@/features/player/use-stream-probes";
import { probeStreamUrls, type StreamProbe } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({ probeStreamUrls: vi.fn() }));
afterEach(cleanup);

it("keeps a manual line choice when an earlier probe completes", async () => {
  let finish!: (results: StreamProbe[]) => void;
  vi.mocked(probeStreamUrls).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useStreamProbes(["https://a", "https://b"], "channel"));
  act(() => result.current.selectStream(1));
  await act(async () => finish([
    { index: 0, url: "https://a", ok: true, elapsedMs: 10, mediaKind: "hls", message: "ok" },
    { index: 1, url: "https://b", ok: false, elapsedMs: 20, mediaKind: "hls", message: "failed" },
  ]));
  expect(result.current.streamIndex).toBe(1);
  expect(result.current.isProbing).toBe(false);
});
