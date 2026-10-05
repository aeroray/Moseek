import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaPlayer } from "@/features/player/media-player";

/**
 * The FLV pipeline's wiring to mpegts.js.
 *
 * The bug this guards is the whole reason the pipeline exists: hls.js cannot play FLV, so an FLV
 * stream handed to it fails as "manifestLoadError", naming a stage that never applied. Detection is
 * unit tested separately in `media-player.test.ts`; what is asserted here is that a detected FLV
 * source actually reaches mpegts.js with the custom loader installed, that the loader honours the
 * `BaseLoader` contract mpegts.js drives it through, and that a measured container can move an
 * address off hls.js.
 *
 * mpegts.js is mocked rather than loaded: it needs a real `MediaSource` to do anything, and this
 * suite is about the wiring, not about its demuxer.
 */
interface LoaderLike {
  _status: number;
  needStashBuffer: boolean;
  isWorking(): boolean;
  currentSpeed: number;
  open(dataSource: { url?: string }): void;
  abort(): void;
  destroy(): void;
  onDataArrival:
    | ((chunk: ArrayBuffer, byteStart: number, received?: number) => void)
    | null;
  onURLRedirect: ((url: string) => void) | null;
  onError: ((type: string, info: { code: number; msg: string }) => void) | null;
}

const createdPlayers: ControllablePlayer[] = [];
let lastLoader: LoaderLike | null = null;

vi.mock("mpegts.js", () => {
  const Events = {
    ERROR: "error",
    MEDIA_INFO: "media_info",
    STATISTICS_INFO: "statistics_info",
  };
  const LoaderStatus = { kIdle: 0, kConnecting: 1, kBuffering: 2, kError: 3, kComplete: 4 };
  const LoaderErrors = {
    OK: "OK",
    EXCEPTION: "Exception",
    HTTP_STATUS_CODE_INVALID: "HttpStatusCodeInvalid",
    CONNECTING_TIMEOUT: "ConnectingTimeout",
    EARLY_EOF: "EarlyEof",
    UNRECOVERABLE_EARLY_EOF: "UnrecoverableEarlyEof",
  };
  class Player {
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    attached: HTMLMediaElement | null = null;
    loaded = 0;
    unloaded = 0;
    destroyed = 0;
    played = 0;
    /** The loader this player built, so teardown can be modelled faithfully. */
    loader: LoaderLike | null = null;
    constructor(
      public dataSource: { type: string; isLive?: boolean; url: string },
      public config: Record<string, unknown>,
    ) {
      createdPlayers.push(this as unknown as ControllablePlayer);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    attachMediaElement(element: HTMLMediaElement) {
      this.attached = element;
    }
    load() {
      this.loaded += 1;
      // mpegts.js builds the loader from the config and then drives it through `open`.
      const Loader = this.config.customLoader as
        | (new (seek: unknown, config: Record<string, unknown>) => LoaderLike)
        | undefined;
      if (!Loader) return;
      this.loader = new Loader({}, this.config);
      lastLoader = this.loader;
      this.loader.open(this.dataSource);
    }
    unload() {
      this.unloaded += 1;
    }
    play() {
      this.played += 1;
      return Promise.resolve();
    }
    pause() {}
    /**
     * Models the real teardown chain: `Player.destroy()` -> `unload()` -> `transmuxer.destroy()` ->
     * `ioctl.destroy()` -> `loader.destroy()` -> `abort()`. Modelling only a counter would let a
     * leaked stream pass, which is exactly the defect this suite is meant to catch: a live response
     * never ends, so a loader that is not aborted keeps downloading.
     */
    destroy() {
      this.destroyed += 1;
      this.loader?.destroy();
      this.loader = null;
    }
  }
  return {
    default: {
      Events,
      LoaderStatus,
      LoaderErrors,
      ErrorTypes: {
        NETWORK_ERROR: "NetworkError",
        MEDIA_ERROR: "MediaError",
        OTHER_ERROR: "OtherError",
      },
      ErrorDetails: {
        NETWORK_EXCEPTION: "NetworkException",
        NETWORK_STATUS_CODE_INVALID: "NetworkStatusCodeInvalid",
        NETWORK_UNRECOVERABLE_EARLY_EOF: "NetworkUnrecoverableEarlyEof",
        MEDIA_FORMAT_ERROR: "MediaFormatError",
        MEDIA_CODEC_UNSUPPORTED: "MediaCodecUnsupported",
        MEDIA_MSE_ERROR: "MediaMSEError",
      },
      isSupported: () => true,
      createPlayer: (
        dataSource: { type: string; isLive?: boolean; url: string },
        config: Record<string, unknown>,
      ) => new Player(dataSource, config),
    },
  };
});

// The streaming command is the transport the loader drives; stubbing it keeps this suite about
// wiring rather than about IPC. The callbacks are captured so a test can push real chunks.
const streamMediaResource = vi.fn();
const cancelMediaStream = vi.fn();
const probeMediaContainer = vi.fn();
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauriRuntime: () => true,
    streamMediaResource: (...args: unknown[]) => streamMediaResource(...args),
    cancelMediaStream: (...args: unknown[]) => cancelMediaStream(...args),
    probeMediaContainer: (...args: unknown[]) => probeMediaContainer(...args),
  };
});

/**
 * The player is faked rather than loaded.
 *
 * jsdom cannot reproduce what actually matters about Plyr here: it has no `MediaSource`, and the
 * behaviour this suite pins — that the player is built **once** for an element and never rebuilt
 * when the pipeline changes under it — is a property of *our* wiring, not of Plyr's internals. The
 * numbers behind it were measured in a real browser; see `MediaPipelineEvents` in the component.
 */
interface FakePlyr {
  media: HTMLVideoElement;
  options: Record<string, unknown>;
  destroyCount: number;
  emit(event: string, ...args: unknown[]): void;
}
const createdPlyrs = [] as FakePlyr[];
vi.mock("plyr", () => {
  class Plyr {
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    currentTime = 0;
    duration = 0;
    muted = false;
    destroyCount = 0;
    constructor(
      public media: HTMLVideoElement,
      public options: Record<string, unknown>,
    ) {
      createdPlyrs.push(this as unknown as FakePlyr);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    destroy() {
      this.destroyCount += 1;
    }
  }
  return { default: Plyr };
});

interface ControllablePlayer {
  emit(event: string, ...args: unknown[]): void;
  loaded: number;
  unloaded: number;
  destroyed: number;
  dataSource: { type: string; isLive?: boolean; url: string };
}

interface StreamCallbacks {
  onChunk: (chunk: Uint8Array) => void;
  onMeta?: (meta: { kind: "meta"; url: string }) => void;
  onError?: (message: string) => void;
}

let streamCallbacks: StreamCallbacks | null = null;

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

async function mountPlayer(url: string, kind: "hls" | "mp4" | "unknown" = "unknown") {
  stubTextTracks();
  const statuses: string[] = [];
  render(
    <MediaPlayer
      title="斗鱼 431460"
      url={url}
      kind={kind}
      isLive
      fill
      onStatus={(status) => statuses.push(status)}
    />,
  );
  // The boot is deferred by one macrotask so StrictMode cannot build the player twice.
  await waitFor(() => expect(createdPlayers.length + statuses.length).toBeGreaterThan(0));
  return statuses;
}

describe("MediaPlayer FLV pipeline wiring", () => {
  beforeEach(() => {
    createdPlayers.length = 0;
    createdPlyrs.length = 0;
    lastLoader = null;
    streamCallbacks = null;
    streamMediaResource.mockReset();
    cancelMediaStream.mockReset();
    probeMediaContainer.mockReset();
    streamMediaResource.mockImplementation((...args: unknown[]) => {
      streamCallbacks = {
        onChunk: args[3] as StreamCallbacks["onChunk"],
        onMeta: args[4] as StreamCallbacks["onMeta"],
        onError: args[5] as StreamCallbacks["onError"],
      };
      return Promise.resolve({ cancel: vi.fn() });
    });
    // The default: the probe has not answered, which is the state the player boots in.
    probeMediaContainer.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps a plain live address on hls.js until the container has been measured", async () => {
    // The honest default. Most extension-less live addresses really are HLS, and the pipeline only
    // moves once the container has actually been measured.
    await mountPlayer("https://live.ottiptv.cc/douyu/431460");
    expect(createdPlayers).toHaveLength(0);
  });

  it("routes an explicit .flv address straight to mpegts.js with the Tauri loader", async () => {
    await mountPlayer("http://cdn.example/live/stream.flv");
    await waitFor(() => expect(createdPlayers.length).toBeGreaterThan(0));
    const player = createdPlayers[0];
    expect(player.loaded).toBeGreaterThan(0);
    // The loader is what keeps the request behind the Rust policy; without it mpegts.js would fetch
    // directly from the webview and be refused for CORS.
    expect(lastLoader).not.toBeNull();
    expect(streamMediaResource).toHaveBeenCalled();
  });

  it("moves a measured FLV container off hls.js", async () => {
    // The real failing channel: the requested address names no extension and only becomes an FLV
    // two redirects later. This is the case no URL-based rule could catch.
    probeMediaContainer.mockResolvedValue({
      container: "flv",
      contentType: "video/x-flv",
      url: "http://huosa.douyucdn2.cn/live/431460rrhSOIDkva_550.flv?token=abc",
      probedBytes: 65536,
      message: "文件头为 FLV",
    });
    await mountPlayer("https://live.ottiptv.cc/douyu/431460");
    await waitFor(() => expect(createdPlayers.length).toBeGreaterThan(0));
    expect(createdPlayers[0].dataSource.type).toBe("flv");
    expect(createdPlayers[0].dataSource.url).toBe(
      "https://live.ottiptv.cc/douyu/431460",
    );
  });

  it("keeps the same player standing when the pipeline changes under it", async () => {
    // The defect the user reported as "nothing plays, not even the player appears". Plyr refuses to
    // initialise an element twice — `setup()` returns early on `if (this.media.plyr)` and nothing,
    // including `destroy()`, ever clears that back-reference — and `destroy()` also replaces the
    // element with a clone. So tearing the player down to rebuild it for the next pipeline left the
    // app driving an element that was no longer in the document, with no player around it at all:
    // measured against the real channel, mpegts.js decoded 425 frames into a detached element while
    // the DOM held a source-less clone and zero `.plyr` surfaces. The player therefore belongs to
    // the element and survives the swap.
    //
    // The pipeline is moved here by changing the source rather than by a probe answer, because that
    // is the part jsdom can actually perform: it has no `MediaSource`, so `Hls.isSupported()` is
    // false and the HLS half of a probe-driven switch never builds a player for the teardown to
    // lose. What is asserted is our own contract either way — one player per element, never rebuilt.
    const { rerender } = render(
      <MediaPlayer
        title="斗鱼 431460"
        url="http://cdn.example/live/stream.flv"
        kind="unknown"
        isLive
        fill
      />,
    );
    await waitFor(() => expect(createdPlyrs).toHaveLength(1));
    const player = createdPlyrs[0];

    rerender(
      <MediaPlayer
        title="斗鱼 431460"
        url="http://cdn.example/live/stream.flv"
        kind="mp4"
        isLive={false}
        fill
      />,
    );

    await waitFor(() => expect(createdPlayers.length).toBeGreaterThan(0));
    expect(createdPlyrs).toHaveLength(1);
    expect(createdPlyrs[0]).toBe(player);
    expect(player.destroyCount).toBe(0);
    expect(player.media).toBe(document.querySelector("video"));
  });

  it("forwards chunks in arrival order with the stream offset they begin at", async () => {
    // `byteStart` is load-bearing for mpegts.js: it is the stream offset the chunk begins at, and a
    // wrong value misplaces timestamps rather than merely logging oddly.
    await mountPlayer("http://cdn.example/live/stream.flv");
    await waitFor(() => expect(lastLoader).not.toBeNull());
    const received: Array<{ byteStart: number; length: number }> = [];
    lastLoader!.onDataArrival = (chunk, byteStart) => {
      received.push({ byteStart, length: chunk.byteLength });
    };

    streamCallbacks!.onChunk(new Uint8Array([1, 2, 3]));
    streamCallbacks!.onChunk(new Uint8Array([4, 5]));

    expect(received).toEqual([
      { byteStart: 0, length: 3 },
      { byteStart: 3, length: 2 },
    ]);
  });

  it("reports the final address from the stream metadata as a redirect", async () => {
    await mountPlayer("http://cdn.example/live/stream.flv");
    await waitFor(() => expect(lastLoader).not.toBeNull());
    const redirected: string[] = [];
    lastLoader!.onURLRedirect = (url) => redirected.push(url);

    streamCallbacks!.onMeta!({
      kind: "meta",
      url: "http://cdn.example/live/final.flv",
    });

    expect(redirected).toEqual(["http://cdn.example/live/final.flv"]);
  });

  it("stops the upstream stream when the player is torn down", async () => {
    // A live response never ends on its own, so a stream left behind would keep downloading until
    // the process exits. This is asserted through the loader contract rather than the player's own
    // counter: `destroy()` on the player is only useful if it reaches `abort()`.
    await mountPlayer("http://cdn.example/live/stream.flv");
    await waitFor(() => expect(lastLoader).not.toBeNull());
    const loader = lastLoader!;
    expect(loader.isWorking()).toBe(true);

    cleanup();

    expect(loader._status).toBe(0);
    expect(loader.isWorking()).toBe(false);
  });

  it("reports an FLV failure without ever mentioning an HLS manifest", async () => {
    // The whole point of the pipeline: an FLV stream is not a playlist, so blaming a manifest would
    // describe a stage that never ran — which is exactly the misdiagnosis being fixed.
    const statuses: string[] = [];
    stubTextTracks();
    const messages: string[] = [];
    render(
      <MediaPlayer
        title="斗鱼 431460"
        url="http://cdn.example/live/stream.flv"
        kind="unknown"
        isLive
        fill
        onStatus={(status, message) => {
          statuses.push(status);
          if (message) messages.push(message);
        }}
      />,
    );
    await waitFor(() => expect(createdPlayers.length).toBeGreaterThan(0));
    const player = createdPlayers[0];

    // Exhaust the reconnect budget so the failure is reported rather than retried.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      player.emit("error", "NetworkError", "NetworkStatusCodeInvalid", {
        code: 403,
        msg: "Forbidden",
      });
    }

    expect(statuses).toContain("error");
    const reported = messages.join(" | ");
    expect(reported).not.toContain("清单");
    expect(reported).toContain("403");
  });
});
