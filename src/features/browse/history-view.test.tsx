import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryView } from "@/features/browse/history-view";
import type { FootprintRecord, LiveChannel, VodItem } from "@/types/moseek";

const { useAppStore } = await import("@/stores/app-store");

function item(name: string): VodItem {
  return {
    id: "vod-1",
    sourceKey: "cms-main",
    sourceName: "主用影视源",
    name,
    poster: "",
    description: "",
    year: "2026",
    area: "",
    categories: [],
    actors: [],
    directors: [],
    // The record names its line by looking it up here, so the fixture has to carry the lines the
    // real snapshot does.
    playLines: [
      {
        id: "line-1",
        name: "线路一",
        episodes: [{ id: "ep-1", name: "第01集", url: "https://cdn/1.m3u8" }],
      },
    ],
  };
}

function channel(name: string): LiveChannel {
  return {
    id: `live-main:${name}`,
    name,
    groupId: "news",
    groupName: "新闻",
    logoUrl: "",
    streamUrl: "https://s/n.m3u8",
    streamUrls: ["https://s/n.m3u8"],
    mediaKind: "hls",
    sourceKey: "live-main",
  };
}

function vodFootprint(overrides: Partial<Extract<FootprintRecord, { kind: "vod" }>> = {}) {
  return {
    kind: "vod" as const,
    id: "vod-1:ep-1",
    item: item("冬城猎凶"),
    lineId: "line-1",
    episodeId: "ep-1",
    episodeName: "第01集",
    progress: 620,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function liveFootprint() {
  return {
    kind: "live" as const,
    id: "live-main:City News",
    channel: channel("City News"),
    sourceName: "直播源",
    updatedAt: new Date().toISOString(),
  };
}

describe("HistoryView", () => {
  afterEach(cleanup);

  beforeEach(() => {
    useAppStore.setState({ history: [] });
  });

  it("is named 足迹 rather than 播放历史", () => {
    render(<HistoryView onNavigate={() => {}} />);
    expect(
      screen.getByRole("heading", { name: "足迹" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/最近播放历史/)).toBeNull();
  });

  it("splits the two kinds into their own columns", () => {
    // A film and a channel are watched for different reasons, and interleaving them meant
    // scanning past rows that were never candidates for what you were looking for.
    useAppStore.setState({ history: [vodFootprint(), liveFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    const vodColumn = screen.getByRole("region", { name: "影视足迹" });
    const liveColumn = screen.getByRole("region", { name: "电视足迹" });

    // Each entry is in its own column, not merely somewhere on the page.
    expect(vodColumn).toHaveTextContent("冬城猎凶");
    expect(vodColumn).not.toHaveTextContent("City News");
    expect(liveColumn).toHaveTextContent("City News");
    expect(liveColumn).not.toHaveTextContent("冬城猎凶");
  });

  it("gives each column its own count", () => {
    useAppStore.setState({
      history: [
        vodFootprint(),
        vodFootprint({ id: "vod-1:ep-2", episodeId: "ep-2" }),
        liveFootprint(),
      ],
    });
    render(<HistoryView onNavigate={() => {}} />);

    expect(
      screen.getByRole("region", { name: "影视足迹" }),
    ).toHaveTextContent("2 条");
    expect(
      screen.getByRole("region", { name: "电视足迹" }),
    ).toHaveTextContent("1 条");
  });

  it("is read-only — no row navigates anywhere", () => {
    // An earlier version made every row a button back into the library, which promised a return
    // to the exact place and could not deliver it.
    const onNavigate = vi.fn();
    useAppStore.setState({ history: [vodFootprint(), liveFootprint()] });
    render(<HistoryView onNavigate={onNavigate} />);

    // The only button is the header's clear action; nothing in either timeline is interactive.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("清空足迹");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps the newest record first", () => {
    // The order is the information: a history read out of order is not a history.
    useAppStore.setState({
      history: [
        vodFootprint({ id: "newer", item: item("更新的"), updatedAt: new Date().toISOString() }),
        vodFootprint({ id: "older", item: item("更早的"), updatedAt: "2020-01-01T00:00:00.000Z" }),
      ],
    });
    render(<HistoryView onNavigate={() => {}} />);

    const names = screen.getAllByText(/更新的|更早的/).map((n) => n.textContent);
    expect(names).toEqual(["更新的", "更早的"]);
  });

  it("states the episode, the line it played on, and the position", () => {
    useAppStore.setState({ history: [vodFootprint()] });
    const { container } = render(<HistoryView onNavigate={() => {}} />);

    expect(screen.getByText("第01集")).toBeInTheDocument();
    // The line is named rather than shown as an id: it is what the user picked in the rail.
    expect(screen.getByText(/线路 线路一/)).toBeInTheDocument();
    // The position is stated and drawn as a bar, since a timestamp alone does not say how far
    // through that is. Scoped to the bar's own class, because Radix's scroll viewport also
    // carries inline styles.
    expect(screen.getByText("10:20")).toBeInTheDocument();
    const bar = container.querySelector("span[style*='width']");
    expect(bar).not.toBeNull();
    expect(bar?.className).toContain("bg-primary/70");
  });

  it("omits the progress bar when there is no position to show", () => {
    // A bar at zero would claim the user had started, which "刚开始看" does not mean.
    useAppStore.setState({ history: [vodFootprint({ progress: 0 })] });
    const { container } = render(<HistoryView onNavigate={() => {}} />);

    expect(screen.getByText("第01集")).toBeInTheDocument();
    expect(container.querySelector("span[style*='width']")).toBeNull();
  });

  it("names the channel's group rather than a line", () => {
    // A channel has no line; showing an empty one would be worse than showing nothing.
    useAppStore.setState({ history: [liveFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    const liveColumn = screen.getByRole("region", { name: "电视足迹" });
    expect(liveColumn).toHaveTextContent("新闻");
    expect(liveColumn).not.toHaveTextContent("线路");
  });

  it("keeps an empty column visible and explains it", () => {
    // With only films watched, the television column must still be there. Collapsing it would
    // leave a page that looks half-built, and the reader could not tell whether the app had lost
    // their channel history or simply had none.
    useAppStore.setState({ history: [vodFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    const liveColumn = screen.getByRole("region", { name: "电视足迹" });
    expect(liveColumn).toHaveTextContent("还没有电视足迹");
    expect(liveColumn).toHaveTextContent("0 条");
    // It offers the way to produce one.
    expect(
      screen.getByRole("button", { name: "去电视直播看看" }),
    ).toBeInTheDocument();
  });

  it("keeps the film column visible when only channels were watched", () => {
    // The mirror case, which a one-sided implementation would miss.
    useAppStore.setState({ history: [liveFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    const vodColumn = screen.getByRole("region", { name: "影视足迹" });
    expect(vodColumn).toHaveTextContent("还没有影视足迹");
    expect(vodColumn).toHaveTextContent("0 条");
    expect(
      screen.getByRole("button", { name: "去影视库看看" }),
    ).toBeInTheDocument();
  });

  it("shows the single overall empty state only when both sides are empty", () => {
    // One message for "nothing at all" is clearer than two identical panels saying the same
    // thing, and it names both ways in.
    useAppStore.setState({ history: [] });
    render(<HistoryView onNavigate={() => {}} />);

    expect(screen.getByText("还没有足迹")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "影视足迹" })).toBeNull();
    expect(screen.queryByRole("region", { name: "电视足迹" })).toBeNull();
  });

  it("explains how to get a first record when there are none", () => {
    // The empty state names both ways in, since either one produces a footprint.
    render(<HistoryView onNavigate={() => {}} />);

    expect(screen.getByText("还没有足迹")).toBeInTheDocument();
    // Scoped to the description: "影视库" also appears in the action button's label.
    expect(
      screen.getByText(/在影视库点开任意影片/),
    ).toBeInTheDocument();
    expect(screen.getByText(/电视直播里选择频道/)).toBeInTheDocument();
  });

  it("clears through the store rather than pretending to", () => {
    useAppStore.setState({ history: [vodFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    screen.getByRole("button", { name: /清空足迹/ }).click();
    expect(useAppStore.getState().history).toHaveLength(0);
  });
});
