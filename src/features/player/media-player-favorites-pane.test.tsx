import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewPane } from "@/components/view-pane";
import { MediaPlayer } from "@/features/player/media-player";

/**
 * The real player, in the shape the favourites page renders it.
 *
 * **The reported defect: "从收藏页面点击播放内容后，切到别的页面，收藏页面的内容还在后台进行播放，并且还在播放
 * 声音".** The favourites page opens a favourite by swapping its columns for a detail component
 * (`FavoriteWatchView` / `FavoriteLiveView`), and both of those render a `MediaPlayer`. The pane keeps
 * that subtree mounted on purpose — it is what preserves the page — so the player has to be the thing
 * that stops, which is what this asserts.
 *
 * The player is mounted directly rather than through the detail component because both details resolve
 * their address through a *dynamic* `await import("@/lib/tauri")`, which a static `vi.mock` does not
 * intercept, so neither reaches its `<video>` here. The page-level wiring — that the pane's context
 * reaches a player rendered by the favourites page — is covered by `favorites-view-away.test.tsx`.
 */

/**
 * Every Plyr the player built, with the options it was given.
 *
 * **Wrapped rather than replaced.** The defect lives in what Plyr itself does with its `autoplay`
 * option, so a hand-written fake would answer the question with its author's assumption rather than
 * with Plyr's behaviour. The subclass records the arguments and then chains to the real constructor, so
 * the instance under test is genuine and the assertion is about the value Plyr really received.
 */
const createdPlyrs: Array<{ options: Record<string, unknown> }> = [];
vi.mock("plyr", async () => {
  const actual = await vi.importActual<{
    default: new (...args: unknown[]) => object;
  }>("plyr");
  const Real = actual.default;
  class Recorded extends Real {
    constructor(...args: unknown[]) {
      super(...args);
      createdPlyrs.push({ options: (args[1] ?? {}) as Record<string, unknown> });
    }
  }
  return { default: Recorded };
});

/**
 * hls.js is stubbed so the HLS branch actually runs, and this is load-bearing for the test below.
 *
 * **Measured: with the real hls.js in jsdom, Plyr is never constructed at all.** `Hls.isSupported()`
 * is false without a MediaSource, so the player falls through to the "runtime cannot play HLS" branch
 * and `ensurePlayer` is never reached — a probe confirmed `plyrs=0`. That is precisely how the
 * `autoplay` option went unobserved while three tests passed against the broken code, and it is why
 * this file needs the mock to ask its question at all.
 *
 * Only the surface the player touches is implemented; the pipeline's *behaviour* is not under test
 * here, the options handed to Plyr are.
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
    startLoad() {}
    stopLoad() {}
    loadSource() {}
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

/** Plyr constructs a TextTrack list on the element, which jsdom does not implement. */
function stubTextTracks() {
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
}

describe("the real player in a pane", () => {
  let spies: { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    spies = stubMediaPlayback();
    stubTextTracks();
    createdPlyrs.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function player() {
    return (
      <MediaPlayer
        title="收藏频道"
        url="https://stream.example/live.m3u8"
        kind="hls"
        isLive
        fill
      />
    );
  }

  it("pauses its media element when the pane is put away", async () => {
    // This is what the user hears. The pane deliberately keeps the subtree alive, so pausing the
    // element is the only thing that stops the audio.
    const { rerender } = render(<ViewPane active>{player()}</ViewPane>);

    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const video = document.querySelector("video")!;
    // The user is watching when they navigate away.
    setPaused(video, false);

    rerender(<ViewPane active={false}>{player()}</ViewPane>);

    expect(spies.pause).toHaveBeenCalled();
  });

  it("keeps the element mounted, so returning does not reload it", async () => {
    // The pause must not be a teardown: the page is meant to be preserved, and rebuilding the player
    // is the separate defect that broke FLV playback.
    const { rerender } = render(<ViewPane active>{player()}</ViewPane>);

    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const video = document.querySelector("video")!;
    setPaused(video, false);

    rerender(<ViewPane active={false}>{player()}</ViewPane>);

    expect(document.querySelector("video")).toBe(video);
    expect(video.isConnected).toBe(true);
  });

  it("does not let a player that mounts inside a hidden pane start itself", async () => {
    // **The scenario the other tests miss, and the one the favourites page actually produces.**
    // `FavoriteLiveView` keys its player on the resolved stream URL, and `useStreamProbes` changes that
    // URL when a probe finishes — which can happen after the user has navigated away. The key changes,
    // React unmounts the old player and mounts a new one, and the new one has no memory of having been
    // paused.
    //
    // **Asserted on the `autoplay` attribute, because that is the mechanism.** Every other guard in the
    // component covers *our* calls to `play()`; the attribute is the element starting itself, and
    // nothing in the component is consulted when it does. jsdom does not implement autoplay playback,
    // so a test that only watched `play()` would pass against the broken code — which is what happened
    // here: this assertion was added after three passing tests failed to catch the defect.
    render(<ViewPane active={false}>{player()}</ViewPane>);

    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    // Let the deferred pipeline construction run; Plyr and hls.js are built a macrotask after mount.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const video = document.querySelector("video")!;
    expect(video.autoplay).toBe(false);
    expect(video.preload).not.toBe("auto");
  });

  it("does not hand Plyr an autoplay option, which was the audio the user still heard", async () => {
    // **The defect this test exists for, and why the assertion above did not catch it.**
    //
    // `video.autoplay = false` is not the whole story. Plyr does not just mirror the option onto the
    // element: when its `autoplay` option is true it binds **its own** one-shot handler —
    // `this.once('canplay', () => this.play())` — on its container, which it feeds by re-dispatching
    // every media event, `canplay` included. That path calls `play()` without consulting anything in
    // this component: not `viewAwayRef`, not `requestLivePlayback`, not the retry policy.
    //
    // So a live channel kept buffering after the user left, fired `canplay` when the first fragment
    // landed, and Plyr started the stream into an empty room. That is why the sound appeared "过一阵子"
    // rather than at the moment of navigating away — it waited for that first buffered fragment.
    //
    // Measured in isolation against the real Plyr and a real <video>: `autoplay: true` produced exactly
    // one `play()` from a single `canplay` dispatch; `autoplay: false` produced none.
    //
    // The option is asserted rather than the effect, because jsdom cannot play media: the option is
    // what arms the handler, so asserting it is asserting the mechanism. Deleting the fix turns this
    // red while the attribute test above stays green — which is exactly the gap being closed.
    render(<ViewPane active>{player()}</ViewPane>);
    await waitFor(() => expect(createdPlyrs.length).toBeGreaterThan(0));

    expect(createdPlyrs.at(-1)!.options.autoplay).toBe(false);
  });

  it("never writes the autoplay attribute, which is what armed Plyr's own canplay handler", async () => {
    // **The mechanism, and the reason `autoplay: false` on the constructor was not enough.**
    //
    // Plyr reads the *attribute* at construction and forces its own config from it:
    //
    //     if (this.media.hasAttribute('autoplay')) { this.config.autoplay = true; }
    //
    // so passing `autoplay: false` is overridden the moment the element carries the attribute. Plyr then
    // registers `once('canplay', () => this.play())` on its container, which it feeds by re-dispatching
    // media events — a path that consults nothing in this component.
    //
    // **Measured on the real build**, leaving a channel while it was still buffering: the play() that
    // fired on the hidden pane had a stack entirely inside Plyr — `HTMLVideoElement canplay` → Plyr's
    // proxy → Plyr's container listener → `Plyr.play()` → `HTMLMediaElement.play()` — and the stream ran
    // for the ~10 s it took to drain the buffer. That is the "过一阵子我会听到直播那边的声音" the user
    // reported: nothing is paused because nothing had buffered yet, and the sound begins when the first
    // fragment lands.
    //
    // **Mounted with the view VISIBLE, which is the case that matters.** The effect that writes the
    // attribute runs on mount, so a test that mounts into a hidden pane never exercises the line: the
    // hidden branch writes `false`, and the rerender that reveals the pane does not re-run it. That is
    // exactly why the mutation restoring this line survived the rest of this suite.
    render(<ViewPane active>{player()}</ViewPane>);
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 60));

    const video = document.querySelector("video")!;
    expect(video.hasAttribute("autoplay")).toBe(false);
    // The same trap on the return path, which used to restore it.
    expect(createdPlyrs.at(-1)!.options.autoplay).toBe(false);
  });

  it("starts itself again once the view comes back", async () => {
    // The other half: withholding `preload` must not leave a player inert for ever. With
    // `preload="none"` nothing is even fetched, so a pane that returned would show a spinner that never
    // resolved.
    //
    // **`autoplay` is asserted to stay false, which is the stronger form of this check.** It used to be
    // asserted `true` on return, and that assertion was itself part of the defect: Plyr forces its own
    // `config.autoplay` to true whenever the element carries the attribute, whatever the constructor was
    // told, which armed Plyr's `once('canplay', () => play())` on a live element. The attribute is now
    // never written; the stream is started by this component's own guarded path, which is what the
    // `preload` restoration and the resume branch below actually do.
    const { rerender } = render(<ViewPane active={false}>{player()}</ViewPane>);
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 60));
    const video = document.querySelector("video")!;
    expect(video.autoplay).toBe(false);

    rerender(<ViewPane active>{player()}</ViewPane>);

    expect(video.preload).toBe("auto");
    // Never re-armed, on either side of the navigation.
    expect(video.autoplay).toBe(false);
  });
});
