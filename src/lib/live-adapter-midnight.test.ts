import { describe, expect, it } from "vitest";

import { findCurrentProgram, findNextProgram } from "@/lib/live-adapter";
import type { EpgProgram } from "@/types/moseek";

function program(title: string, startAt: string, endAt: string): EpgProgram {
  return { id: title, channelId: "CCTV1", title, description: "", startAt, endAt };
}

// Guides are emitted as `HH:MM` with no date, so a schedule that runs past midnight is
// indistinguishable from one that started earlier the same day. These tests pin the behaviour at
// the boundary, which is where the app spends its late evening.
describe("programme lookup across midnight", () => {
  it("finds the programme airing now when it wraps past midnight", () => {
    // 23:30–00:30, and it is 23:45.
    const programs = [program("Late Film", "23:30", "00:30")];
    const now = new Date(2026, 0, 1, 23, 45);

    expect(findCurrentProgram(programs, now)?.title).toBe("Late Film");
  });

  it("finds a programme that starts after midnight as the next one", () => {
    // The bug: at 23:43 the next programme starts at 00:13. A naive `start > now` comparison
    // rejects it because 13 sorts before 1423 minutes, so the footer claimed nothing was coming
    // while a programme was 30 minutes away.
    const programs = [
      program("Morning News", "23:13", "00:13"),
      program("Evening Report", "00:13", "01:13"),
    ];
    const now = new Date(2026, 0, 1, 23, 43);

    expect(findNextProgram(programs, now)?.title).toBe("Evening Report");
  });

  it("still finds the next programme earlier in the day", () => {
    const programs = [
      program("Morning News", "11:18", "12:18"),
      program("Evening Report", "12:18", "13:18"),
    ];
    const now = new Date(2026, 0, 1, 11, 48);

    expect(findNextProgram(programs, now)?.title).toBe("Evening Report");
  });

  it("finds the current programme earlier in the day", () => {
    const programs = [
      program("Morning News", "11:18", "12:18"),
      program("Evening Report", "12:18", "13:18"),
    ];
    const now = new Date(2026, 0, 1, 11, 48);

    expect(findCurrentProgram(programs, now)?.title).toBe("Morning News");
  });
});
