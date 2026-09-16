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

  it("collapses the back control to an icon", () => {
    // The header used to spell out "返回列表" next to an ArrowLeft. The label was the widest
    // thing in a header whose only job is to name the work.
    renderPlayer();

    const back = screen.getByLabelText("返回列表");
    expect(back.textContent).toBe("");
    expect(document.querySelector("header")?.textContent).not.toContain("返回列表");
  });

  it("removes the source/line/episode sub-line from the header", () => {
    // The same facts are already visible in the episode rail and on the player itself.
    renderPlayer();

    const header = document.querySelector("header");
    expect(header?.textContent).not.toContain("电影天堂");
    expect(header?.textContent).not.toContain("dyttm3u8");
  });

  it("moves the episode stepper below the player", async () => {
    // 上一集/下一集 sat in the header next to the title, far from the picture they change.
    renderPlayer();

    const header = document.querySelector("header");
    expect(header?.textContent).not.toContain("上一集");
    expect(header?.textContent).not.toContain("下一集");

    // They live in the player column, after the player surface. The player only mounts once
    // the episode address has been resolved, so this has to await it.
    const player = await screen.findByTestId("media-player");
    const stepper = screen.getByRole("button", { name: "上一集" });
    expect(
      player.compareDocumentPosition(stepper) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("removes the overflow menu and its sniffing / external-player actions", () => {
    // Both features were deleted outright: the sniffer companion and the external player are
    // no longer reachable from the app.
    renderPlayer();

    expect(screen.queryByLabelText("更多播放操作")).not.toBeInTheDocument();
    expect(screen.queryByText("本地嗅探")).not.toBeInTheDocument();
    expect(screen.queryByText("用外部播放器打开")).not.toBeInTheDocument();
  });

  it("keeps no status strip and no diagnostics row while playback is healthy", () => {
    // The status line under the player restated what the player controls already show, and a
    // healthy session has no diagnostics worth reading.
    renderPlayer();

    expect(screen.queryByText("等待播放")).not.toBeInTheDocument();
    expect(screen.queryByText("已暂停")).not.toBeInTheDocument();
    expect(screen.queryByText("播放诊断")).not.toBeInTheDocument();
    expect(screen.queryByText(/事件时间线/)).not.toBeInTheDocument();
  });

  it("offers the diagnostics as a dialog once playback fails", async () => {
    // The panel became a button that opens a modal, and it only exists after a failure.
    resolvePlayback.mockRejectedValue(new Error("上游拒绝访问当前地址"));
    renderPlayer();

    const trigger = await screen.findByRole("button", { name: /播放诊断/ });
    // Nothing from the panel body is mounted until the dialog opens.
    expect(screen.queryByRole("button", { name: /复制诊断/ })).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(await screen.findByRole("button", { name: /复制诊断/ })).toBeInTheDocument();
    // The failure reason is carried into the dialog as the panel's note.
    expect(screen.getAllByText(/上游拒绝访问当前地址/).length).toBeGreaterThan(0);
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
