import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewPane } from "@/components/view-pane";
import { MediaPlayer } from "@/features/player/media-player";

/**
 * A live stream must stay silent once its view is put away.
 *
 * **The reported defect: "切到别的页面之后，还能在后台听到直播播放的声音".** Pausing the element when the
 * pane is hidden is not sufficient on its own, and that was the whole extent of the original fix. The
 * live pipeline has its own recovery paths — `requestLivePlayback`'s retry timer, the FLV reconnect,
 * the HLS window refresh — and they fire from timers. Each of them called `play()` without asking
 * whether anyone was still looking, so a stream that was mid-recovery when the user navigated away
 * started again behind a hidden pane.
 *
 * This suite therefore drives those timers rather than just toggling `active`: a test that only
 * checked "pause was called" would pass against the broken code, which is why the original test did.
 */

/** Every handler the player registered, so the pipeline can be driven as the library would drive it. */
const handlers = new Map<string, (event: unknown, data: unknown) => void>();
/**
 * The most recently constructed hls.js instance.
 *
 * Captured through a factory rather than by aliasing `this` inside the class, which the lint config
 * rejects (`no-this-alias`) — and the factory is clearer anyway: it says the instance is recorded for
 * the test, not used by the class.
 */
let hls: {
  startLoad: ReturnType<typeof vi.fn>;
  stopLoad: ReturnType<typeof vi.fn>;
  loadSource: ReturnType<typeof vi.fn>;
} | null = null;

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
      BUFFER_APPENDED: "hlsBufferAppended",
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
    constructor() {
      // Recorded for the test's assertions; see the note on `hls` above for why it is not `this`.
      hls = {
        startLoad: this.startLoad,
        stopLoad: this.stopLoad,
        loadSource: this.loadSource,
      };
    }
    on(event: string, handler: (event: unknown, data: unknown) => void) {
      handlers.set(event, handler);
    }
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

function livePlayer(onStatus?: (status: string, message?: string) => void) {
  return (
    <MediaPlayer
      title="CCTV1"
      url="https://stream.example/live.m3u8"
      kind="hls"
      isLive
      fill
      onStatus={onStatus}
    />
  );
}

describe("a live stream whose view is put away", () => {
  let spies: { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    spies = stubMediaPlayback();
    handlers.clear();
    hls = null;
    // Plyr constructs a TextTrack list on the element, which jsdom does not implement. Stubbed the way
    // `media-player-events.test.tsx` does it, rather than by patching the element's property — that
    // property is a getter and cannot be assigned.
    vi.stubGlobal(
      "TextTrack",
      class {
        kind = "";
        label = "";
        language = "";
        mode = "disabled";
      },
    );
    vi.stubGlobal("TextTrackList", class extends Array {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Drives the pipeline to the point where the player believes it has buffered media. */
  async function bufferFirstFragment() {
    await waitFor(() => expect(handlers.has("hlsFragBuffered")).toBe(true));
    handlers.get("hlsManifestParsed")?.({}, { levels: [{ height: 1080 }] });
    handlers.get("hlsFragBuffered")?.(
      {},
      { frag: { sn: 1 }, stats: { loaded: 1000, total: 1000 } },
    );
    // The buffer handler asks for playback, which resolves on a microtask.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("starts playing while the user is watching", async () => {
    // The control: proves the pipeline really does reach `play()` on its own, so the assertions below
    // are about the away-guard rather than about a path that never ran.
    render(<ViewPane active>{livePlayer()}</ViewPane>);
    const video = document.querySelector("video")!;
    setPaused(video, true);

    await bufferFirstFragment();

    expect(spies.play).toHaveBeenCalled();
  });

  it("does not start playing when a fragment arrives after the user left", async () => {
    // The defect. The user navigates away, and the stream delivers a fragment while the pane is
    // hidden — exactly the situation that produced audio from a page nobody was looking at.
    const { rerender } = render(<ViewPane active>{livePlayer()}</ViewPane>);
    const video = document.querySelector("video")!;
    setPaused(video, false);
    await waitFor(() => expect(handlers.has("hlsFragBuffered")).toBe(true));

    rerender(<ViewPane active={false}>{livePlayer()}</ViewPane>);
    expect(spies.pause).toHaveBeenCalledTimes(1);

    spies.play.mockClear();
    // The fragment arrives now that the user is elsewhere.
    handlers.get("hlsFragBuffered")?.(
      {},
      { frag: { sn: 2 }, stats: { loaded: 1000, total: 1000 } },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spies.play).not.toHaveBeenCalled();
  });

  it("rejoins the live edge when the user comes back", async () => {
    // Returning must not simply resume a stale buffer: the element was paused, so what it holds is
    // behind the live edge. hls.js is told to load from the edge again.
    const { rerender } = render(<ViewPane active>{livePlayer()}</ViewPane>);
    const video = document.querySelector("video")!;
    setPaused(video, false);
    await bufferFirstFragment();

    rerender(<ViewPane active={false}>{livePlayer()}</ViewPane>);
    const instance = hls!;
    instance.startLoad.mockClear();

    rerender(<ViewPane active>{livePlayer()}</ViewPane>);

    expect(instance.startLoad).toHaveBeenCalled();
  });

  it("says nothing about muting when the stream was never muted", async () => {
    // The second reported defect: "播放器默认静音了，这个很奇怪". The element used to be muted up front for
    // every live stream, which is why a channel opened silent with its slider already down.
    render(<ViewPane active>{livePlayer()}</ViewPane>);
    const video = document.querySelector("video")!;

    expect(video.muted).toBe(false);
    expect(video.defaultMuted).toBe(false);
  });

  it("does not judge the stream while the user is away", async () => {
    // The first reported defect, from the other end: "回来之后每次都要刷新". A paused element cannot
    // produce a fragment, so a watchdog that keeps counting while the pane is hidden fails a perfectly
    // healthy stream, and the user comes back to a channel that is already reconnecting.
    //
    // **Asserted on the recovery attempt rather than on an error message, and that distinction is the
    // whole test.** The first version checked that no `error` status arrived — and it passed against the
    // broken code, because a watchdog's first act on expiry is to *try* a recovery, and only a failed
    // recovery reports. `stopLoad` is the teardown `recoverLiveWindow` performs, so asserting it did not
    // happen is what actually pins "the watchdog did not act".
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ViewPane active>{livePlayer()}</ViewPane>);
      const video = document.querySelector("video")!;
      setPaused(video, false);
      // Let the deferred construction run so the watchdog is armed while the view is still on screen.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const instance = hls!;
      instance.stopLoad.mockClear();
      instance.startLoad.mockClear();
      instance.loadSource.mockClear();

      rerender(<ViewPane active={false}>{livePlayer()}</ViewPane>);

      // Well past the startup budget, with no fragment ever arriving — expected, because the element is
      // paused and nothing is fetching.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(instance.stopLoad).not.toHaveBeenCalled();
      expect(instance.loadSource).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the stream its full budget again after the user comes back", async () => {
    // The other half of the same rule. Suppressing the watchdog while away must not leave a returned
    // view with no deadline at all, or a genuinely dead stream would sit on the spinner for ever
    // instead of reporting failure.
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const report = (status: string, message?: string) => {
        if (status === "error") errors.push(message ?? "error");
      };
      const { rerender } = render(<ViewPane active>{livePlayer(report)}</ViewPane>);
      const video = document.querySelector("video")!;
      setPaused(video, false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      // Away long enough that the original deadline would have expired twice over.
      rerender(<ViewPane active={false}>{livePlayer(report)}</ViewPane>);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(errors).toEqual([]);

      // Back, and still nothing buffering: the watchdog is allowed to judge now, and it must — a
      // deadline that never restarts would hide a dead stream rather than report it.
      rerender(<ViewPane active>{livePlayer(report)}</ViewPane>);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(errors.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
