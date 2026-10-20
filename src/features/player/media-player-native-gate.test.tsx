import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaPlayer } from "@/features/player/media-player";
import { resolveMediaElementUrl } from "@/lib/tauri";

/**
 * The native `<video>` branch must not hand the element an unverified address.
 *
 * HLS and FLV go through `TauriMediaLoader`/`TauriFlvLoader`, so every request passes the Rust URL
 * policy. An `mp4` assigned straight to `video.src` bypasses all of it: the webview resolves the
 * host, follows the host's redirects, and an imported document could point the element at a
 * loopback or private address the policy exists to refuse. `resolveMediaElementUrl` runs the same
 * walk first and only the address it returns reaches the element.
 *
 * These tests assert the *mechanism* — that the gate is consulted and that its answer, not the raw
 * address, is what gets assigned — because that is the part a future refactor can silently drop.
 * The redirect and DNS rules themselves live in Rust and are covered there.
 */

vi.mock("hls.js", () => {
  class Hls {
    static Events = {
      MANIFEST_LOADING: "hlsManifestLoading",
      MANIFEST_LOADED: "hlsManifestLoaded",
      MANIFEST_PARSED: "hlsManifestParsed",
      LEVEL_LOADED: "hlsLevelLoaded",
      FRAG_LOADING: "hlsFragLoading",
      FRAG_LOADED: "hlsFragLoaded",
      FRAG_BUFFERED: "hlsFragBuffered",
      MEDIA_ATTACHED: "hlsMediaAttached",
      ERROR: "hlsError",
    };
    static isSupported() {
      return true;
    }
    levels: unknown[] = [];
    currentLevel = -1;
    loadLevel = -1;
    constructor(_config?: unknown) {}
    on() {}
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    stopLoad() {}
    destroy() {}
  }
  class LoadStats {}
  return { default: Hls, LoadStats };
});

const plyrInstances: Array<{
  duration: number;
  handlers: Map<string, () => void>;
  emit: (event: string) => void;
}> = [];

vi.mock("plyr", () => ({
  default: class {
    duration = 3600;
    handlers = new Map<string, () => void>();
    constructor() {
      plyrInstances.push(this as unknown as (typeof plyrInstances)[number]);
    }
    on(event: string, handler: () => void) {
      this.handlers.set(event, handler);
    }
    emit(event: string) {
      this.handlers.get(event)?.();
    }
    destroy() {}
  },
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauriRuntime: () => true,
  // The address the gate approved. Deliberately different from the requested one, so an assertion
  // that `video.src` equals the *original* URL cannot pass by accident.
  resolveMediaElementUrl: vi.fn(async () => "https://approved.example/final.mp4"),
}));

function stubTextTracks() {
  vi.stubGlobal("TextTrack", class {});
  vi.stubGlobal("TextTrackList", class extends Array {});
}

function stubPlayback() {
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.resolve()),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
}

function mediaElement(): HTMLVideoElement {
  const video = document.querySelector("video");
  if (!video) throw new Error("no <video> was rendered");
  return video;
}

/** The `src` attribute actually on the element — `null` when nothing has been assigned. */
function assignedSrc(): string | null {
  return mediaElement().getAttribute("src");
}

function renderNativePlayer(onStatus?: (status: string, message?: string) => void) {
  return render(
    <MediaPlayer
      title="藏海传 · 第08集"
      url="https://cdn.example/8.mp4"
      kind="mp4"
      onStatus={onStatus}
    />,
  );
}

describe("the native video pipeline and the media URL gate", () => {
  beforeEach(() => {
    plyrInstances.length = 0;
    stubTextTracks();
    stubPlayback();
    vi.mocked(resolveMediaElementUrl).mockReset();
    vi.mocked(resolveMediaElementUrl).mockResolvedValue(
      "https://approved.example/final.mp4",
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("assigns the address the gate approved, not the one it was given", async () => {
    // The core of the fix. A direct assignment would have put the raw URL on the element before any
    // check could run, which is exactly the bypass being closed.
    renderNativePlayer();

    await waitFor(() => {
      expect(assignedSrc()).toBe("https://approved.example/final.mp4");
    });
    expect(resolveMediaElementUrl).toHaveBeenCalledWith(
      "https://cdn.example/8.mp4",
    );
  });

  it("does not leave the raw address on the element while the gate is answering", async () => {
    // The window between "start loading" and "gate answered" must not be a window in which the
    // element is already fetching. Asserted on a deferred promise, which is the only way to observe
    // that state rather than the settled one.
    let release!: (value: string) => void;
    vi.mocked(resolveMediaElementUrl).mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    renderNativePlayer();

    // Give the deferred boot its macrotask, then look before the gate has answered.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(resolveMediaElementUrl).toHaveBeenCalled();
    expect(assignedSrc()).toBeNull();

    await act(async () => {
      release("https://approved.example/final.mp4");
    });
    await waitFor(() => {
      expect(assignedSrc()).toBe("https://approved.example/final.mp4");
    });
  });

  it("refuses to play and says so when the gate rejects the address", async () => {
    const statuses: Array<{ status: string; message?: string }> = [];
    vi.mocked(resolveMediaElementUrl).mockRejectedValue(
      "目标地址指向本地网络，策略不允许",
    );
    renderNativePlayer((status, message) => {
      statuses.push({ status, message });
    });

    await waitFor(() => {
      expect(statuses.some((entry) => entry.status === "error")).toBe(true);
    });
    // Nothing was assigned, so the element never contacted the refused host.
    expect(assignedSrc()).toBeNull();
    // The wording is the app's own, not the backend's rule text: the latter names our policy rather
    // than describing what happened to the user's source.
    const error = statuses.find((entry) => entry.status === "error");
    expect(error?.message).toBe("媒体地址未通过安全检查，已拒绝直接播放。");
  });

  it("does not assign anything when no gate is available", async () => {
    // Outside the desktop runtime the command is not registered and the wrapper resolves to null.
    // That means "could not verify", never "approved" — the element must be left alone.
    const statuses: string[] = [];
    vi.mocked(resolveMediaElementUrl).mockResolvedValue(null as unknown as string);
    renderNativePlayer((status) => {
      statuses.push(status);
    });

    await waitFor(() => {
      expect(statuses).toContain("error");
    });
    expect(assignedSrc()).toBeNull();
  });

  it("sends the retry path through the same gate instead of a second direct assignment", async () => {
    // The bypass this closes on the *second* attempt: a retry that assigned the raw URL itself would
    // undo the gate every time a user pressed 重试.
    vi.mocked(resolveMediaElementUrl).mockRejectedValueOnce("refused");
    const statuses: string[] = [];
    renderNativePlayer((status) => {
      statuses.push(status);
    });

    await waitFor(() => {
      expect(statuses).toContain("error");
    });
    expect(assignedSrc()).toBeNull();

    // The player's own failure overlay is what drives `retryRef`.
    const retry = await screen.findByRole("button", { name: "重试" });
    vi.mocked(resolveMediaElementUrl).mockResolvedValue(
      "https://approved.example/final.mp4",
    );
    await act(async () => {
      retry.click();
    });

    await waitFor(() => {
      expect(assignedSrc()).toBe("https://approved.example/final.mp4");
    });
    // Both attempts were gated: one call for the initial load, one for the retry. A retry that
    // assigned the raw URL would leave this at one.
    expect(vi.mocked(resolveMediaElementUrl).mock.calls.length).toBeGreaterThanOrEqual(
      2,
    );
  });
});
