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

  it("starts itself again once the view comes back", async () => {
    // The other half: withholding `autoplay`/`preload` must not leave a player inert for ever. With
    // `preload="none"` nothing is even fetched, so a pane that returned would show a spinner that never
    // resolved.
    const { rerender } = render(<ViewPane active={false}>{player()}</ViewPane>);
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 60));
    const video = document.querySelector("video")!;
    expect(video.autoplay).toBe(false);

    rerender(<ViewPane active>{player()}</ViewPane>);

    expect(video.preload).toBe("auto");
    expect(video.autoplay).toBe(true);
  });
});
