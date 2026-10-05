import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewPane } from "@/components/view-pane";
import { MediaPlayer } from "@/features/player/media-player";

/**
 * A player inside a view that is put away must stop, and must pick up again on return.
 *
 * The views are kept alive so their state survives navigation (see `ViewPane`), which means a player
 * is kept alive with them. Left running, a hidden live stream downloads for as long as the app is
 * open and a hidden episode buffers ahead of nobody. Pausing is what stops both, and it is also what
 * makes the return free: hls.js and mpegts.js keep their buffered data and position across a pause,
 * so coming back resumes rather than reloads.
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
    constructor() {}
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

/** jsdom's media element does not implement play/pause; the calls are what is under test. */
function stubMediaPlayback() {
  const play = vi.fn(() => Promise.resolve());
  const pause = vi.fn();
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: play,
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: pause,
  });
  return { play, pause };
}

/** A paused flag jsdom does implement, so the effect can read the real state. */
function setPaused(video: HTMLVideoElement, paused: boolean) {
  Object.defineProperty(video, "paused", {
    configurable: true,
    get: () => paused,
  });
}

describe("MediaPlayer inside a hidden view", () => {
  let spies: { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    spies = stubMediaPlayback();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("pauses when its view is put away and resumes when it returns", async () => {
    const { rerender } = render(
      <ViewPane active>
        <MediaPlayer
          title="CCTV1"
          url="https://stream.example/live.m3u8"
          kind="hls"
          isLive
          fill
        />
      </ViewPane>,
    );
    const video = document.querySelector("video")!;
    // The player is playing when the user navigates away.
    setPaused(video, false);

    rerender(
      <ViewPane active={false}>
        <MediaPlayer
          title="CCTV1"
          url="https://stream.example/live.m3u8"
          kind="hls"
          isLive
          fill
        />
      </ViewPane>,
    );

    expect(spies.pause).toHaveBeenCalledTimes(1);
    // Nothing is torn down: the same element is still in the document, hidden.
    expect(document.querySelector("video")).toBe(video);
    expect(video.isConnected).toBe(true);

    rerender(
      <ViewPane active>
        <MediaPlayer
          title="CCTV1"
          url="https://stream.example/live.m3u8"
          kind="hls"
          isLive
          fill
        />
      </ViewPane>,
    );

    expect(spies.play).toHaveBeenCalledTimes(1);
  });

  it("does not start a player the user had deliberately paused", async () => {
    // Navigating back to a view is not a request to start playing something the user stopped.
    const { rerender } = render(
      <ViewPane active>
        <MediaPlayer
          title="CCTV1"
          url="https://stream.example/live.m3u8"
          kind="hls"
          isLive
          fill
        />
      </ViewPane>,
    );
    const video = document.querySelector("video")!;
    setPaused(video, true);

    rerender(
      <ViewPane active={false}>
        <MediaPlayer
          title="CCTV1"
          url="https://stream.example/live.m3u8"
          kind="hls"
          isLive
          fill
        />
      </ViewPane>,
    );
    expect(spies.pause).not.toHaveBeenCalled();

    rerender(
      <ViewPane active>
        <MediaPlayer
          title="CCTV1"
          url="https://stream.example/live.m3u8"
          kind="hls"
          isLive
          fill
        />
      </ViewPane>,
    );
    expect(spies.play).not.toHaveBeenCalled();
  });
});
