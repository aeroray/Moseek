import { cleanup, render, waitFor } from "@testing-library/react";
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
/**
 * Every hls.js instance the player built, so a test can assert on the one actually driving the
 * element. The player may build more than one across a rebuild, and `at(-1)` is the current pipeline.
 */
const hlsInstances: Array<{
  startLoad: ReturnType<typeof vi.fn>;
  stopLoad: ReturnType<typeof vi.fn>;
  loadSource: ReturnType<typeof vi.fn>;
  config: Record<string, unknown>;
}> = [];

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
    startLoad = vi.fn();
    stopLoad = vi.fn();
    loadSource = vi.fn();
    /** The config the player handed over, so the load-start policy can be asserted. */
    config: Record<string, unknown> = {};
    constructor(config: Record<string, unknown> = {}) {
      this.config = config;
      hlsInstances.push(this as unknown as (typeof hlsInstances)[number]);
    }
    on() {}
    attachMedia() {}
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
    vi.stubGlobal("TextTrack", class {});
    vi.stubGlobal("TextTrackList", class extends Array {});
    spies = stubMediaPlayback();
    hlsInstances.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    // Plyr and hls.js are constructed on a deferred macrotask (the player must not build twice under
    // StrictMode), so the pipeline has to exist before the resume can be observed on it.
    await waitFor(() => expect(hlsInstances.length).toBeGreaterThan(0));

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

    const hls = hlsInstances.at(-1)!;
    hls.startLoad.mockClear();

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

    // Live is resumed through the pipeline rather than by a bare `play()` here: the element was paused
    // while the view was away, so what it holds is behind the live edge, and playing it directly would
    // show stale content and then stall. `startLoad` is hls.js being told to fetch again from the live
    // edge, which is the signal that the resume went through the right path.
    expect(hls.startLoad).toHaveBeenCalled();
  });

  it("does not let hls.js start loading for a view the user has left", async () => {
    // **The reported defect on the HLS path: "切到别的页面，过一阵子还能听到直播的声音".**
    //
    // hls.js starts fetching by itself. `loadSource` triggers `MANIFEST_LOADING`, and the playlist
    // loader answers that by calling `startLoad` unless `autoStartLoad` is false — so the address being
    // recorded is also the download starting. This branch is reached from a deferred macrotask and from
    // a channel switch, either of which can land after the user has navigated away, which is why the
    // sound arrives a while later rather than at the moment of leaving: it waits for the buffered data.
    //
    // Suppressed through hls.js's own switch rather than by withholding `loadSource`, because the URL
    // still has to be recorded — `startLoad(-1)` is a no-op before a source is set, so skipping
    // `loadSource` would leave the returning viewer with a player that never loads.
    render(
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
    await waitFor(() => expect(hlsInstances.length).toBeGreaterThan(0));

    expect(hlsInstances.at(-1)!.config.autoStartLoad).toBe(false);
    // The address is still recorded, which is what makes the resume work.
    expect(hlsInstances.at(-1)!.loadSource).toHaveBeenCalled();
  });

  it("lets hls.js start loading again once the view comes back", async () => {
    // The other half: the flag must not be a permanent refusal, or returning would show a black pane.
    const { rerender } = render(
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
    await waitFor(() => expect(hlsInstances.length).toBeGreaterThan(0));
    const hls = hlsInstances.at(-1)!;
    hls.startLoad.mockClear();

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

    // `startLoad(-1)` is what hls.js is told on return; with `autoStartLoad` false it is the only
    // thing that starts the download, so this is the signal that returning really does load.
    expect(hls.startLoad).toHaveBeenCalled();
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
