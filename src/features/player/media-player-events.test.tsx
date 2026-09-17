import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaPlayer } from "@/features/player/media-player";

/**
 * Events the player subscribes to, recorded across instances.
 *
 * The bug this guards is not visible in the rendered output: the player subscribed to
 * `BUFFER_APPENDED` and treated it as proof that media had buffered. That event also fires when
 * an append contributes nothing, so the live recovery counter was reset on every cycle, the
 * recovery limit was never reached, and a stream that could not play stayed on the loading
 * spinner forever instead of reporting a failure. Only `FRAG_BUFFERED` means a fragment was
 * demuxed and buffered.
 */
const registeredEvents: string[] = [];

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
    on(event: string) {
      registeredEvents.push(event);
    }
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    stopLoad() {}
    destroy() {}
  }
  class LoadStats {}
  return { default: Hls, LoadStats };
});

describe("MediaPlayer HLS event wiring", () => {
  afterEach(() => {
    cleanup();
    registeredEvents.length = 0;
  });

  it("treats only a buffered fragment as buffering progress", async () => {
    // Plyr constructs a TextTrack list on the element, which jsdom does not implement.
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
    try {
      render(
        <MediaPlayer
          title="CCTV1"
          url="https://stream.example/live.m3u8"
          kind="hls"
          isLive
          fill
        />,
      );

      // Construction is deferred by one macrotask so StrictMode cannot build hls.js twice.
      await waitFor(() => {
        expect(registeredEvents.length).toBeGreaterThan(0);
      });

      expect(registeredEvents).toContain("hlsFragBuffered");
      // `BUFFER_APPENDED` also fires for an append that contributed nothing, so treating it as
      // success reset the recovery counter endlessly and the player never gave up.
      expect(registeredEvents).not.toContain("hlsBufferAppended");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
