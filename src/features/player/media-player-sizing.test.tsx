import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaPlayer } from "@/features/player/media-player";

// jsdom has no MediaSource, so the real hls.js reports itself unsupported and the player
// takes its "this environment cannot play HLS" branch before the loading state can be
// observed. Stubbing hls.js as supported is what makes these tests describe the desktop app.
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

// jsdom does not lay out flex or resolve CSS, so these assert the class contract that the
// browser layout depends on. The bug they guard is geometric: a player wrapper with no size
// inside the live workspace's centring flex container collapses to the <video> element's
// intrinsic 300x150 box, so the player rendered as a small stamp on a large black pane.
//
// Plyr wraps the video asynchronously (one macrotask, deferred so StrictMode cannot build it
// twice), so the tests locate the component's own root by the <video> it renders rather than
// by Plyr's `.plyr` class, which is not present synchronously.
function playerWrapper() {
  return document.querySelector("video")?.parentElement as HTMLElement | null;
}

describe("MediaPlayer sizing contract", () => {
  afterEach(cleanup);

  it("stretches to fill its container when fill is set", () => {
    render(
      <MediaPlayer
        title="CCTV1"
        url="https://stream.example/a.m3u8"
        kind="hls"
        isLive
        fill
      />,
    );

    const wrapper = playerWrapper();
    expect(wrapper?.className).toContain("h-full");
    expect(wrapper?.className).toContain("w-full");
    // `.plyr` itself carries no height, so its `.plyr__video-wrapper{height:100%}` would
    // otherwise resolve against auto and collapse to the video's intrinsic 150px.
    expect(wrapper?.className).toContain("[&_.plyr]:h-full");
  });

  it("keeps the natural aspect-ratio box when fill is not set", () => {
    // The VOD player sits in a normal document-flow column and must keep its 16:9 box.
    render(
      <MediaPlayer
        title="Movie 1 · EP1"
        url="https://cdn.example/1.m3u8"
        kind="hls"
      />,
    );

    const wrapper = playerWrapper();
    expect(wrapper?.className).not.toContain("h-full");
    expect(wrapper?.className).not.toContain("[&_.plyr]:h-full");
    const video = wrapper?.querySelector("video");
    expect(video?.className).toContain("aspect-video");
  });

  it("hides the untouched video while a live stream is still connecting", () => {
    render(
      <MediaPlayer
        title="CCTV1"
        url="https://stream.example/a.m3u8"
        kind="hls"
        isLive
        fill
      />,
    );

    const video = playerWrapper()?.querySelector("video");
    expect(video?.className).toContain("opacity-0");
    // The loading layer names the channel so the pane reads as "connecting", not "empty".
    expect(document.body.textContent).toContain("正在连接 CCTV1");
  });

  it("does not hide the video for VOD playback", () => {
    render(
      <MediaPlayer
        title="Movie 1 · EP1"
        url="https://cdn.example/1.m3u8"
        kind="hls"
      />,
    );

    const video = playerWrapper()?.querySelector("video");
    expect(video?.className).not.toContain("opacity-0");
  });
});
