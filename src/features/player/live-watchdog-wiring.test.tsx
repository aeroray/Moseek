import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaPlayer } from "@/features/player/media-player";
import type { MediaStatus } from "@/features/player/media-diagnostics";

/**
 * The wiring between hls.js events and the startup watchdog.
 *
 * The extracted rule in `live-watchdog.ts` is unit tested, but a correct rule that is never fed the
 * right inputs is dead code: if the player never records that a fragment request is in flight, the
 * decision can never postpone, and the exact defect it exists to prevent comes straight back. This
 * suite drives the real event sequence against fake timers so that wiring is observable.
 *
 * Reproduced from the user's own diagnostic: the stream delivered a 1.9 MB fragment after ~12.4 s,
 * while the old watchdog fired at a flat 10 s and its recovery called `stopLoad()`, aborting the
 * request it was waiting for.
 */
const instances: ControllableHls[] = [];
const stopLoadCalls: number[] = [];

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
    handlers = new Map<string, ((event: unknown, data?: unknown) => void)[]>();
    constructor() {
      instances.push(this as unknown as ControllableHls);
    }
    on(event: string, handler: (event: unknown, data?: unknown) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }
    emit(event: string, data?: unknown) {
      for (const handler of this.handlers.get(event) ?? []) handler({}, data);
    }
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    stopLoad() {
      stopLoadCalls.push(Date.now());
    }
    destroy() {}
  }
  class LoadStats {}
  return { default: Hls, LoadStats };
});

interface ControllableHls {
  emit(event: string, data?: unknown): void;
}

/** Plyr builds a TextTrack list on the element, which jsdom does not implement. */
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

async function mountLivePlayer(statuses: MediaStatus[]) {
  stubTextTracks();
  render(
    <MediaPlayer
      title="CCTV1"
      url="https://stream.example/live.m3u8"
      kind="hls"
      isLive
      fill
      onStatus={(status) => statuses.push(status)}
    />,
  );
  // The one-macrotask boot delay runs before hls.js is constructed.
  await vi.advanceTimersByTimeAsync(1);
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
}

describe("MediaPlayer live watchdog wiring", () => {
  beforeEach(() => {
    instances.length = 0;
    stopLoadCalls.length = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not abort a slow fragment when the old 10-second deadline passes", async () => {
    const statuses: MediaStatus[] = [];
    await mountLivePlayer(statuses);
    const hls = instances[0];

    // A fragment request is outstanding, exactly as it was for 12.4 s on the real stream.
    hls.emit("hlsFragLoading", { frag: { sn: 51105 } });

    // Past the old flat deadline, which used to call stopLoad() and cancel this very request.
    await vi.advanceTimersByTimeAsync(11_000);

    expect(stopLoadCalls).toHaveLength(0);
    expect(statuses).not.toContain("error");
  });

  it("stops waiting as soon as a fragment has been buffered", async () => {
    const statuses: MediaStatus[] = [];
    await mountLivePlayer(statuses);
    const hls = instances[0];

    hls.emit("hlsFragLoading", { frag: { sn: 1 } });
    hls.emit("hlsFragBuffered", { frag: { sn: 1 } });

    // Well past every deadline; a buffered fragment means there is nothing left to watch for.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(stopLoadCalls).toHaveLength(0);
    expect(statuses).not.toContain("error");
  });

  it("still gives up when a request never settles, so the spinner cannot be endless", async () => {
    // The counterpart: the budget is fixed, so a source that accepts a fragment request and never
    // answers must eventually become a reported failure rather than an eternal spinner. This is a
    // defect this project has already fixed once.
    const statuses: MediaStatus[] = [];
    await mountLivePlayer(statuses);
    const hls = instances[0];

    hls.emit("hlsFragLoading", { frag: { sn: 1 } });
    // Past the attempt budget, and then past the recovery window that follows it.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(statuses).toContain("error");
    expect(stopLoadCalls.length).toBeGreaterThan(0);
  });

  it("reports a stall promptly once a fragment has settled without buffering", async () => {
    // A fragment that finished downloading but never reached the buffer means nothing is in flight
    // and nothing has buffered — a genuinely stalled pipeline, not a slow one. Clearing the
    // in-flight marker when the fragment settles is what lets the watchdog tell those apart: if it
    // stayed set, this would be postponed to the full 35-second budget and a dead stream would take
    // half a minute to be reported.
    const statuses: MediaStatus[] = [];
    await mountLivePlayer(statuses);
    const hls = instances[0];

    hls.emit("hlsFragLoading", { frag: { sn: 1 } });
    hls.emit("hlsFragLoaded", { frag: { sn: 1 }, payload: { byteLength: 1_000 } });

    // Well inside the budget: two recovery rounds and the failure land around 16s.
    await vi.advanceTimersByTimeAsync(25_000);

    expect(statuses).toContain("error");
  });
});
