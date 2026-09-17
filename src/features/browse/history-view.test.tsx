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
    playLines: [],
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

  it("shows both a work and a channel on the same timeline", () => {
    // They are the two things a user can watch, and a history that silently omitted one would be
    // wrong about where they had been.
    useAppStore.setState({ history: [vodFootprint(), liveFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    expect(screen.getByText("冬城猎凶")).toBeInTheDocument();
    expect(screen.getByText("City News")).toBeInTheDocument();
    expect(screen.getByText("影视")).toBeInTheDocument();
    expect(screen.getByText("直播")).toBeInTheDocument();
  });

  it("is read-only — no row navigates anywhere", () => {
    // An earlier version made every row a button back into the library, which promised a return
    // to the exact place and could not deliver it.
    const onNavigate = vi.fn();
    useAppStore.setState({ history: [vodFootprint(), liveFootprint()] });
    render(<HistoryView onNavigate={onNavigate} />);

    // The only button is the header's clear action; nothing in the timeline is interactive.
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

  it("states the episode and position for a work", () => {
    useAppStore.setState({ history: [vodFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    expect(screen.getByText(/第01集/)).toBeInTheDocument();
    expect(screen.getByText(/看到 10:20/)).toBeInTheDocument();
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
