import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    const liveColumn = screen.getByRole("region", { name: "电视直播足迹" });

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
      screen.getByRole("region", { name: "电视直播足迹" }),
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

  it("groups entries under the day they happened", () => {
    // The day is what makes this a timeline rather than a list with dots: it answers "when"
    // before the reader parses a timestamp, and it lets each row show only a clock time.
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    useAppStore.setState({
      history: [
        vodFootprint({ id: "a", item: item("今天看的"), updatedAt: now.toISOString() }),
        vodFootprint({
          id: "b",
          item: item("昨天看的"),
          updatedAt: yesterday.toISOString(),
        }),
      ],
    });
    render(<HistoryView onNavigate={() => {}} />);

    const column = screen.getByRole("region", { name: "影视足迹" });
    expect(column).toHaveTextContent("今天");
    expect(column).toHaveTextContent("昨天");
    // The clock time is shown, not the full date, because the group already states the day.
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes(),
    ).padStart(2, "0")}`;
    expect(column).toHaveTextContent(time);
  });

  it("does not merge a record with an unreadable timestamp into another day", () => {
    // Silently folding it into the group above would misreport when it happened.
    useAppStore.setState({
      history: [
        vodFootprint({ id: "a", item: item("正常的"), updatedAt: new Date().toISOString() }),
        vodFootprint({ id: "b", item: item("坏的"), updatedAt: "not-a-date" }),
      ],
    });
    render(<HistoryView onNavigate={() => {}} />);

    const column = screen.getByRole("region", { name: "影视足迹" });
    expect(column).toHaveTextContent("正常的");
    expect(column).toHaveTextContent("坏的");
    expect(column).toHaveTextContent("not-a-date");
  });

  it("draws the rail across a day boundary, not just within one day", () => {
    // The rail ended at every day boundary because "last" was taken from the day group rather
    // than the column. A column with one record per day — exactly what the channel column holds —
    // therefore drew no connecting line at all, and the two columns stopped looking like one
    // component.
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    const base = liveFootprint();
    useAppStore.setState({
      history: [
        base,
        {
          ...base,
          id: "live-main:CCTV1",
          channel: { ...base.channel, id: "live-main:CCTV1", name: "CCTV1" },
          updatedAt: yesterday.toISOString(),
        },
      ],
    });
    render(<HistoryView onNavigate={() => {}} />);

    const column = screen.getByRole("region", { name: "电视直播足迹" });
    const rows = [...column.querySelectorAll("li")];
    expect(rows).toHaveLength(2);

    // The first row is not the last in the column, so it must draw a connector even though it is
    // the last row of its own day.
    const connectors = (row: Element) =>
      [...row.querySelectorAll("span")].filter((s) =>
        (s.className ?? "").includes("w-px"),
      ).length;
    expect(connectors(rows[0])).toBe(1);
    // The genuinely last row ends the rail.
    expect(connectors(rows[1])).toBe(0);
  });

  it("does not repeat the counts beside the page title", () => {
    // Each column states its own count; a second pair up here only asked the reader to compare
    // two places for the same fact.
    useAppStore.setState({ history: [vodFootprint(), liveFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    const heading = screen.getByRole("heading", { name: "足迹" });
    const header = heading.closest("header");
    expect(header?.textContent).not.toMatch(/影视\s*\d/);
    expect(header?.textContent).not.toMatch(/直播\s*\d/);
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

    const liveColumn = screen.getByRole("region", { name: "电视直播足迹" });
    expect(liveColumn).toHaveTextContent("新闻");
    expect(liveColumn).not.toHaveTextContent("线路");
  });

  it("keeps an empty column visible and explains it", () => {
    // With only films watched, the television column must still be there. Collapsing it would
    // leave a page that looks half-built, and the reader could not tell whether the app had lost
    // their channel history or simply had none.
    useAppStore.setState({ history: [vodFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    const liveColumn = screen.getByRole("region", { name: "电视直播足迹" });
    expect(liveColumn).toHaveTextContent("还没有电视直播足迹");
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
    expect(screen.queryByRole("region", { name: "电视直播足迹" })).toBeNull();
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
    useAppStore.setState({ history: [vodFootprint(), liveFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /清空足迹/ }));
    // Both kinds start selected, so the ordinary case is a single confirm.
    fireEvent.click(screen.getByRole("button", { name: "清空全部" }));

    expect(useAppStore.getState().history).toHaveLength(0);
  });

  it("deselecting a kind clears only the other one", () => {
    // The behaviour the user asked for: the two entries are checkboxes, not buttons that fire the
    // moment they are pressed. Unticking 影视足迹 must leave it alone and clear the live side.
    useAppStore.setState({ history: [vodFootprint(), liveFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /清空足迹/ }));

    // Both are on to begin with, so the scopes are visible before anything is deselected.
    const vod = screen.getByRole("checkbox", { name: "影视足迹" });
    const live = screen.getByRole("checkbox", { name: "电视直播足迹" });
    expect(vod).toHaveAttribute("data-state", "checked");
    expect(live).toHaveAttribute("data-state", "checked");

    fireEvent.click(vod);
    expect(vod).toHaveAttribute("data-state", "unchecked");

    // The action now names the narrower scope instead of claiming to clear everything.
    fireEvent.click(screen.getByRole("button", { name: "清空电视直播足迹" }));

    const remaining = useAppStore.getState().history;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].kind).toBe("vod");
  });

  it("clears the live footprints on their own too", () => {
    useAppStore.setState({ history: [vodFootprint(), liveFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /清空足迹/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "电视直播足迹" }));
    fireEvent.click(screen.getByRole("button", { name: "清空影视足迹" }));

    const remaining = useAppStore.getState().history;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].kind).toBe("live");
  });

  it("disables only the kinds that have nothing in them", () => {
    // A control that would clear nothing cannot be acted on, so it is unavailable rather than
    // silently doing nothing when pressed.
    useAppStore.setState({ history: [vodFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /清空足迹/ }));

    expect(screen.getByRole("checkbox", { name: "影视足迹" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "电视直播足迹" })).toBeDisabled();
    // The empty one is not selected, so the confirm button describes only what it will clear.
    expect(
      screen.getByRole("button", { name: "清空影视足迹" }),
    ).toBeInTheDocument();
  });

  it("cannot confirm with nothing selected", () => {
    // Zero selection means there is nothing to do; the button says so rather than appearing to act.
    useAppStore.setState({ history: [vodFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /清空足迹/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "影视足迹" }));

    expect(screen.getByRole("button", { name: "清空" })).toBeDisabled();
  });

  it("names only the kinds it can actually clear", () => {
    // A kind with no records is unavailable, so counting it in the label would make the button
    // promise more than it can do: with only films recorded, the action must not claim 清空全部.
    useAppStore.setState({ history: [vodFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /清空足迹/ }));

    expect(screen.queryByRole("button", { name: "清空全部" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空影视足迹" })).toBeEnabled();
  });

  it("starts with everything selected again when reopened", () => {
    // A previous deselection must not silently carry over: the next visit would then clear less
    // than the dialog appears to promise.
    useAppStore.setState({ history: [vodFootprint(), liveFootprint()] });
    render(<HistoryView onNavigate={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /清空足迹/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "影视足迹" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    fireEvent.click(screen.getByRole("button", { name: /清空足迹/ }));
    expect(screen.getByRole("checkbox", { name: "影视足迹" })).toHaveAttribute(
      "data-state",
      "checked",
    );
  });

  it("renders a footprint whose item is missing playLines", () => {
    // The record comes back from localStorage, so it may predate a field or have been stored
    // partially filled. Reading `playLines` unguarded took the whole page down with
    // "Cannot read properties of undefined", which the error boundary turned into 界面错误.
    const record = vodFootprint();
    const withoutLines = {
      ...record,
      item: { ...record.item, playLines: undefined },
    } as unknown as FootprintRecord;
    useAppStore.setState({ history: [withoutLines] });

    render(<HistoryView onNavigate={() => {}} />);

    expect(screen.getByText("冬城猎凶")).toBeInTheDocument();
  });
});
