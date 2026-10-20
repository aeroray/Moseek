import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaPlayer } from "@/features/player/media-player";

/**
 * 「接着看」 must actually seek.
 *
 * The reported defect: the watch page and 我的收藏 both display a saved position, both pass it
 * down as `resumeAt`, and playback still started at zero. The seek lived in Plyr's `ready` handler,
 * which fires when Plyr has finished building its DOM — before any media is fetched. At that moment
 * `player.duration` is 0 (Plyr maps both NaN and Infinity to 0), so the `duration > resume` guard
 * was always false, and Plyr's `currentTime` setter returns early while duration is falsy anyway.
 *
 * These tests therefore drive the *media element*, which is where a seek can actually land, and
 * assert on `video.currentTime`. They fail against the previous implementation for the reason just
 * described: the old code only ever touched Plyr's `currentTime`, never the element's.
 *
 * jsdom has no media pipeline, so `duration` and `readyState` are defined per test to model the
 * states a real element passes through (`0`/`NaN` before metadata, a real duration after). The
 * ordering itself — that `loadedmetadata` precedes `canplay` and that a real element refuses a seek
 * outside its seekable range — needs a real browser to confirm (MC-DEC-20261008-9992d36c).
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
      // The native branch is what is under test; keeping HLS "supported" leaves the pipeline
      // derivation to the URL, exactly as in the desktop app.
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

/**
 * Plyr is stubbed to a minimal stand-in that behaves like the real one in the one respect that
 * matters here: its `currentTime` setter is a no-op until it has a duration, and its `ready` event
 * fires before any media exists. That is what made the old seek vanish, so the stub reproduces it
 * rather than papering over it.
 */
const plyrInstances: Array<{
  duration: number;
  currentTime: number;
  handlers: Map<string, () => void>;
  emit: (event: string) => void;
}> = [];

vi.mock("plyr", () => ({
  default: class {
    duration = 0;
    #currentTime = 0;
    handlers = new Map<string, () => void>();
    constructor() {
      plyrInstances.push(this as unknown as (typeof plyrInstances)[number]);
    }
    get currentTime() {
      return this.#currentTime;
    }
    /** Mirrors Plyr's real setter: refused while there is no duration to seek within. */
    set currentTime(value: number) {
      if (!this.duration) return;
      this.#currentTime = value;
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
  // The native pipeline is the one that ever assigns `video.src`, and it now asks the gate first.
  isTauriRuntime: () => true,
  resolveMediaElementUrl: vi.fn(async (url: string) => url),
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

/** jsdom reports a fixed `NaN` duration and `readyState` 0; both are read-only, so redefining the
 *  own property on the element is the only way to model a loaded media file. */
function modelLoadedMedia(
  video: HTMLVideoElement,
  { duration, readyState }: { duration: number; readyState: number },
) {
  Object.defineProperty(video, "duration", {
    configurable: true,
    get: () => duration,
  });
  Object.defineProperty(video, "readyState", {
    configurable: true,
    get: () => readyState,
  });
}

/** The <video> the component renders. Plyr never wraps it here, so it is the direct child. */
function mediaElement(): HTMLVideoElement {
  const video = document.querySelector("video");
  if (!video) throw new Error("no <video> was rendered");
  return video;
}

describe("resume playback position", () => {
  beforeEach(() => {
    plyrInstances.length = 0;
    stubTextTracks();
    stubPlayback();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("seeks the media element to the saved position once metadata arrives", async () => {
    // The whole defect in one assertion: the element's own `currentTime` is what a real seek needs,
    // and the old implementation never wrote to it.
    render(
      <MediaPlayer
        title="藏海传 · 第08集"
        url="https://cdn.example/8.mp4"
        kind="mp4"
        resumeAt={750}
      />,
    );
    const video = mediaElement();

    // Before metadata: no duration, nothing seekable. Emitting `loadedmetadata` here must not
    // attempt a bounded seek, because there is no bound to clamp against yet.
    modelLoadedMedia(video, { duration: NaN, readyState: 0 });
    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.currentTime).toBe(0);

    // Metadata now known: `loadedmetadata` is the first moment a seek can land.
    modelLoadedMedia(video, { duration: 2700, readyState: 1 });
    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(video.currentTime).toBe(750);
  });

  it("clamps a position that is past the end of the media", async () => {
    // A saved position can outlive the file it described: the source re-cut the episode, or the
    // favourite points at a shorter line. Seeking to an unbounded position would throw or leave the
    // element showing a black frame at the end.
    render(
      <MediaPlayer
        title="藏海传 · 第08集"
        url="https://cdn.example/8.mp4"
        kind="mp4"
        resumeAt={5000}
      />,
    );
    const video = mediaElement();
    modelLoadedMedia(video, { duration: 1200, readyState: 1 });

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(video.currentTime).toBe(1200);
  });

  it("does not seek for a position a viewer would consider the start", async () => {
    // `resumeSeconds` already floors anything under 5s, but the player must not treat a stray small
    // value as a resume either — seeking 3s into every fresh episode would be a worse defect than
    // not resuming at all.
    render(
      <MediaPlayer
        title="藏海传 · 第08集"
        url="https://cdn.example/8.mp4"
        kind="mp4"
        resumeAt={3}
      />,
    );
    const video = mediaElement();
    modelLoadedMedia(video, { duration: 2700, readyState: 1 });

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(video.currentTime).toBe(0);
  });

  it("applies a saved position that arrives after the element is already playable", async () => {
    // The store hydrates asynchronously, so the position can be refreshed by the prop-sync effect
    // after the element has already fired its first `canplay`. Applying it then is still correct —
    // and a flag set on the *absence* of a position would have blocked it forever.
    const { rerender } = render(
      <MediaPlayer
        title="藏海传 · 第08集"
        url="https://cdn.example/8.mp4"
        kind="mp4"
        resumeAt={0}
      />,
    );
    const video = mediaElement();
    modelLoadedMedia(video, { duration: 2700, readyState: 4 });

    act(() => {
      video.dispatchEvent(new Event("canplay"));
    });
    expect(video.currentTime).toBe(0);

    rerender(
      <MediaPlayer
        title="藏海传 · 第08集"
        url="https://cdn.example/8.mp4"
        kind="mp4"
        resumeAt={610}
      />,
    );
    // The position is refreshed by an effect, then the next playable event applies it.
    await waitFor(() => {
      act(() => {
        video.dispatchEvent(new Event("canplay"));
      });
      expect(video.currentTime).toBe(610);
    });
  });

  it("seeks a live element whose duration is Infinity instead of refusing", async () => {
    // A live MediaSource reports `Infinity`. There is no upper bound to clamp against, but the
    // saved position is still the intended target, and refusing it was the old behaviour.
    render(
      <MediaPlayer
        title="CCTV1"
        url="https://stream.example/live.mp4"
        kind="mp4"
        isLive
        resumeAt={120}
      />,
    );
    const video = mediaElement();
    modelLoadedMedia(video, { duration: Infinity, readyState: 1 });

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(video.currentTime).toBe(120);
  });

  it("stops listening for metadata once the component is gone", async () => {
    // The listeners live on an element that outlives the pipeline, so a missed removal keeps
    // writing a seek into whatever the element is showing next.
    const { unmount } = render(
      <MediaPlayer
        title="藏海传 · 第08集"
        url="https://cdn.example/8.mp4"
        kind="mp4"
        resumeAt={750}
      />,
    );
    const video = mediaElement();
    modelLoadedMedia(video, { duration: 2700, readyState: 1 });
    unmount();

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(video.currentTime).toBe(0);
  });
});
