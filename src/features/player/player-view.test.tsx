import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlayerView } from "@/features/player/player-view";
import type { SourceRecord, VodEpisode, VodItem } from "@/types/moseek";

const resolvePlayback = vi.fn();

// Plyr + hls.js need a real media element; this suite covers the page's own composition.
vi.mock("@/features/player/media-player", () => ({
  MediaPlayer: ({ title }: { title: string }) => (
    <div data-testid="media-player">{title}</div>
  ),
  usesHlsPipeline: () => true,
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauriRuntime: () => true,
    resolvePlayback: (...args: unknown[]) => resolvePlayback(...args),
  };
});

const { useAppStore } = await import("@/stores/app-store");

const SHOW = "藏海传";

function source(): SourceRecord {
  return {
    key: "cms-1",
    name: "电影天堂",
    sourceType: "cms",
    api: "https://cms.example/api.php",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "supported",
    enabled: true,
    testStatus: "passed",
    lastCheckedAt: "now",
    requestCount: 0,
  } as SourceRecord;
}

const episodes: VodEpisode[] = Array.from({ length: 24 }, (_, index) => ({
  id: `ep-${index + 1}`,
  name: `第${String(index + 1).padStart(2, "0")}集`,
  url: `https://cdn.example/${index + 1}.m3u8`,
}));

function item(): VodItem {
  return {
    id: "vod-1",
    sourceKey: "cms-1",
    sourceName: "电影天堂",
    name: SHOW,
    poster: "",
    description: "简介",
    year: "2026",
    area: "中国大陆",
    categories: [],
    actors: [],
    directors: [],
    playLines: [
      { id: "line-1", name: "dyttm3u8", episodes },
      { id: "line-2", name: "dytt", episodes: episodes.slice(0, 5) },
    ],
  };
}

function renderPlayer() {
  const vod = item();
  return render(
    <PlayerView
      request={{
        item: vod,
        source: source(),
        line: vod.playLines[0],
        episode: vod.playLines[0].episodes[0],
      }}
      onBack={() => {}}
    />,
  );
}

describe("PlayerView composition", () => {
  afterEach(cleanup);

  beforeEach(() => {
    resolvePlayback.mockReset();
    resolvePlayback.mockResolvedValue({
      url: "https://cdn.example/1.m3u8",
      mediaKind: "hls",
      adapterId: "test",
    });
    useAppStore.setState({ playbackProgress: {}, history: [] });
  });

  it("names the work in the header instead of the widget", async () => {
    // The header used to read "播放器视窗", which names the widget rather than the content.
    renderPlayer();

    expect(await screen.findByRole("heading", { name: SHOW })).toBeInTheDocument();
    expect(screen.queryByText("播放器视窗")).not.toBeInTheDocument();
  });

  it("drops the 播放边界 card", () => {
    // It only restated the source, line and protocol, all of which the header and the
    // diagnostics already carry.
    renderPlayer();

    expect(screen.queryByText("播放边界")).not.toBeInTheDocument();
  });

  it("folds the status strip and diagnostics into one collapsed row", () => {
    // The status used to be its own bar with no actionable content, and the diagnostics sat
    // permanently expanded below it.
    renderPlayer();

    const trigger = screen.getByLabelText("展开播放诊断");
    expect(trigger).toBeInTheDocument();
    // Collapsed means the timeline is genuinely not rendered.
    expect(screen.queryByText(/事件时间线/)).not.toBeInTheDocument();
  });

  it("reveals the diagnostics in place when the row is expanded", () => {
    renderPlayer();

    fireEvent.click(screen.getByLabelText("展开播放诊断"));

    expect(screen.getByLabelText("收起播放诊断")).toBeInTheDocument();
    // The copy action and its hint live inside the collapsed content, so their presence proves
    // the panel actually expanded. (The timeline itself needs a live player snapshot, which
    // this suite stubs out.)
    expect(screen.getByRole("button", { name: /复制诊断/ })).toBeInTheDocument();
    expect(
      screen.getByText("播放失败时复制这段内容，可直接定位到具体环节"),
    ).toBeInTheDocument();
  });

  it("moves the secondary actions into an overflow menu", () => {
    // 本地嗅探 and 外部播放器 were a prominent pair on every playback screen despite being
    // rarely used, and they crowded the header.
    renderPlayer();

    expect(screen.getByLabelText("更多播放操作")).toBeInTheDocument();
    const header = document.querySelector("header");
    expect(header?.textContent).not.toContain("本地嗅探");
    expect(header?.textContent).not.toContain("外部播放器");
  });

  it("lets the episode rail fill its column instead of a fixed height", () => {
    // The rail was `min-h-[560px]` with an inner fixed-height list, which left dead space
    // under short lists and clipped long ones. It now stretches to the grid row, which
    // requires `min-h-0` so the inner list can shrink and scroll instead of overflowing.
    renderPlayer();

    const rail = [...document.querySelectorAll('[data-slot="card"]')].find((card) =>
      (card.textContent ?? "").includes("线路与选集"),
    );
    expect(rail).toBeTruthy();
    expect(rail?.className).not.toContain("min-h-[560px]");
    expect(rail?.className).toContain("min-h-0");
    // The grid must also be bounded, or the rail would grow with its content instead of
    // scrolling inside the viewport.
    const grid = rail?.parentElement;
    expect(grid?.className).toContain("min-h-0");
    expect(grid?.className).toContain("overflow-hidden");
  });

  it("keeps every episode reachable", () => {
    renderPlayer();

    // The first episode is active; the list must not be truncated by a fixed-height box.
    expect(screen.getAllByRole("button", { name: "第01集" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "第24集" })).toBeInTheDocument();
  });

  it("does not show a capability badge for an ordinary supported source", () => {
    // A green "可用" badge on every normal source is noise; it is only worth surfacing when
    // the source is actually degraded.
    renderPlayer();

    expect(screen.queryByText("可用")).not.toBeInTheDocument();
  });
});
