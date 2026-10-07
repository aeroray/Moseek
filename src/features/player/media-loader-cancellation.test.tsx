import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext } from "hls.js";
import { MediaPlayer } from "@/features/player/media-player";
import { cancelMediaRequest, fetchMediaResource, type MediaResource } from "@/lib/tauri";

let LoaderClass: (new (config: HlsConfig) => Loader<LoaderContext>) | undefined;
const players: { currentTime: number; handlers: Map<string, () => void> }[] = [];

vi.mock("hls.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hls.js")>();
  class Hls {
    static Events = actual.default.Events;
    static isSupported() { return true; }
    levels = [];
    currentLevel = -1;
    loadLevel = -1;
    constructor(config: HlsConfig) { LoaderClass = config.loader; }
    on() {}
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    stopLoad() {}
    destroy() {}
  }
  return { ...actual, default: Hls };
});
vi.mock("plyr", () => ({ default: class {
  currentTime = 0;
  duration = 3600;
  handlers = new Map<string, () => void>();
  constructor() { players.push(this); }
  on(event: string, handler: () => void) { this.handlers.set(event, handler); }
  destroy() {}
} }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tauri")>(),
  isTauriRuntime: () => true,
  fetchMediaResource: vi.fn(), cancelMediaRequest: vi.fn(async () => undefined),
}));

const context = { url: "https://example.com/fragment.ts", responseType: "arraybuffer" } as LoaderContext;
const config = { timeout: 1000, loadPolicy: { maxLoadTimeMs: 1000 } } as LoaderConfiguration;
const callbacks = () => ({ onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() });

async function loader() {
  render(<MediaPlayer title="测试" url="https://example.com/vod.m3u8" kind="hls" />);
  await waitFor(() => expect(LoaderClass).toBeDefined());
  return new LoaderClass!({} as HlsConfig);
}

describe("the configured Tauri HLS loader", () => {
  beforeEach(() => { LoaderClass = undefined; players.length = 0; vi.clearAllMocks(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("cancels the backend on abort and ignores its late response", async () => {
    let finish!: (resource: MediaResource) => void;
    vi.mocked(fetchMediaResource).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const instance = await loader();
    const events = callbacks();
    instance.load(context, config, events as LoaderCallbacks<LoaderContext>);
    const id = vi.mocked(fetchMediaResource).mock.calls[0][3];
    instance.abort();
    expect(cancelMediaRequest).toHaveBeenCalledWith(id);
    await act(async () => finish({ bodyBase64: "AQ==", url: context.url }));
    expect(events.onSuccess).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
  });

  it("cancels timed-out work instead of leaving the download running", async () => {
    vi.mocked(fetchMediaResource).mockImplementationOnce(() => new Promise(() => {}));
    const instance = await loader();
    vi.useFakeTimers();
    const events = callbacks();
    instance.load(context, config, events as LoaderCallbacks<LoaderContext>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(events.onTimeout).toHaveBeenCalledOnce();
    expect(cancelMediaRequest).toHaveBeenCalledWith(vi.mocked(fetchMediaResource).mock.calls[0][3]);
    instance.destroy();
  });

  it("reports progress after seeking backwards", async () => {
    const progress = vi.fn();
    render(<MediaPlayer title="测试" url="https://example.com/vod.m3u8" kind="hls" onProgress={progress} />);
    await waitFor(() => expect(players).toHaveLength(1));
    const player = players[0];
    act(() => { player.currentTime = 120; player.handlers.get("timeupdate")!(); });
    act(() => { player.currentTime = 20; player.handlers.get("timeupdate")!(); });
    expect(progress.mock.calls.map(([seconds]) => seconds)).toEqual([120, 20]);
  });
});
