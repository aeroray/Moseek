import { describe, expect, it } from "vitest";

import {
  clearsFailureNote,
  decideLiveWatchdog,
} from "@/features/player/live-watchdog";

/**
 * The reported bug, reproduced from the user's own diagnostic timeline.
 *
 * The stream was fine but slow: each 1.9 MB fragment took ~12.4 s. The old watchdog fired a flat
 * 10 s after load start and its recovery called `stopLoad()`, aborting the request in flight about
 * 2.4 s before it would have arrived. It did that twice, and on the third attempt the recovery
 * budget was spent so it reported 直播流长时间没有收到可播放分片 — whereupon the uncancelled request
 * completed and playback started on its own.
 */
const MEASURED_FRAGMENT_DOWNLOAD_MS = 12_400;
const BUDGET = 35_000;

describe("live startup watchdog", () => {
  it("waits while a slow fragment is still downloading, instead of aborting it", () => {
    // At 10 s into the attempt the fragment has been requested and not yet arrived. The old rule
    // fired here; the correct answer is to keep waiting.
    expect(
      decideLiveWatchdog({
        hasBufferedFragment: false,
        requestInFlight: true,
        now: 10_000,
        deadlineAt: BUDGET,
      }),
    ).toBe("postpone");
  });

  it("does not abort the request at the moment the old watchdog would have", () => {
    // The concrete regression: 10 s is shorter than the measured 12.4 s download.
    expect(MEASURED_FRAGMENT_DOWNLOAD_MS).toBeGreaterThan(10_000);
    const atTenSeconds = decideLiveWatchdog({
      hasBufferedFragment: false,
      requestInFlight: true,
      now: 10_000,
      deadlineAt: BUDGET,
    });
    expect(atTenSeconds).not.toBe("fire");
  });

  it("lets the slow fragment finish inside the budget", () => {
    // The same download, evaluated where it actually completes: still inside the attempt.
    expect(
      decideLiveWatchdog({
        hasBufferedFragment: true,
        requestInFlight: false,
        now: MEASURED_FRAGMENT_DOWNLOAD_MS,
        deadlineAt: BUDGET,
      }),
    ).toBe("stop");
  });

  it("stops watching as soon as a fragment has been buffered", () => {
    expect(
      decideLiveWatchdog({
        hasBufferedFragment: true,
        requestInFlight: false,
        now: 1,
        deadlineAt: 0,
      }),
    ).toBe("stop");
  });

  it("still fires when the attempt has run out of budget with a request outstanding", () => {
    // The budget is fixed, so a request that never settles cannot extend the attempt for ever.
    // Without that bound the player would sit on the spinner instead of reporting a dead stream —
    // a defect this project has already fixed once.
    expect(
      decideLiveWatchdog({
        hasBufferedFragment: false,
        requestInFlight: true,
        now: BUDGET + 1,
        deadlineAt: BUDGET,
      }),
    ).toBe("fire");
  });

  it("fires when nothing is in flight and nothing has buffered", () => {
    // A genuinely stalled pipeline: no request, no picture.
    expect(
      decideLiveWatchdog({
        hasBufferedFragment: false,
        requestInFlight: false,
        now: 5_000,
        deadlineAt: BUDGET,
      }),
    ).toBe("fire");
  });

  it("fires exactly at the deadline rather than postponing past it", () => {
    expect(
      decideLiveWatchdog({
        hasBufferedFragment: false,
        requestInFlight: true,
        now: BUDGET,
        deadlineAt: BUDGET,
      }),
    ).toBe("fire");
  });

  it("never reports a failure for an attempt that has not started waiting yet", () => {
    // Guard against wiring the clock backwards, which would fire immediately on every load.
    expect(
      decideLiveWatchdog({
        hasBufferedFragment: false,
        requestInFlight: true,
        now: 0,
        deadlineAt: BUDGET,
      }),
    ).toBe("postpone");
  });
});

describe("failure note lifecycle", () => {
  it("clears the note for every status that is not a failure", () => {
    // The page went from 播放失败 to 正在播放 with nothing re-requested, so the note has to go with
    // it; otherwise 播放诊断 reads 正在播放 beside a 前置提示 claiming no segment ever arrived.
    for (const status of ["loading", "ready", "playing", "paused", "ended", "idle"]) {
      expect(clearsFailureNote(status)).toBe(true);
    }
  });

  it("keeps the note while the status is a failure", () => {
    expect(clearsFailureNote("error")).toBe(false);
  });
});
