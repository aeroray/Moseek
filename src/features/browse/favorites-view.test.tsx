import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FavoritesView } from "@/features/browse/favorites-view";
import type { SourceRecord, VodFavorite, VodItem } from "@/types/moseek";

const getVodDetail = vi.fn();
const searchVod = vi.fn();
const resolvePlayback = vi.fn();

vi.mock("@/features/browse/cms-adapter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/browse/cms-adapter")>();
  return {
    ...actual,
    getVodDetail: (...args: unknown[]) => getVodDetail(...args),
    searchVod: (...args: unknown[]) => searchVod(...args),
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    resolvePlayback: (...args: unknown[]) => resolvePlayback(...args),
    probeStreamUrls: async () => null,
  };
});

// The player needs a real media element; this suite is about the favourites page's own contract.
// `onStatus` and `onProgress` are recorded on the global so the paths that could unmount or
// re-render the player are actually reachable — an assertion that the player stayed mounted
// passes either way if nothing can emit the event that would have removed it.
vi.mock("@/features/player/media-player", () => ({
  MediaPlayer: ({
    title,
    onStatus,
    onProgress,
  }: {
    title: string;
    onStatus?: (status: string, message?: string) => void;
    onProgress?: (seconds: number) => void;
  }) => {
    const globals = globalThis as {
      __favPlayerOnStatus?: typeof onStatus;
      __favPlayerOnProgress?: typeof onProgress;
    };
    globals.__favPlayerOnStatus = onStatus;
    globals.__favPlayerOnProgress = onProgress;
    return <div data-testid="media-player">{title}</div>;
  },
  usesHlsPipeline: () => true,
}));

const { useAppStore } = await import("@/stores/app-store");

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    key: "cms-main",
    name: "主用影视源",
    sourceType: "cms",
    api: "https://cms.example/api.php/provide/vod",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "demo",
    enabled: true,
    testStatus: "passed",
    lastCheckedAt: "now",
    requestCount: 0,
    ...overrides,
  } as SourceRecord;
}

/**
 * A detail response that is fresh each call, and that stops arriving after `limit` calls.
 *
 * Both properties matter. Returning the same object every time would keep `favorite.item`
 * identical and hide a refresh loop entirely, because a real request produces a new object. And
 * without the limit a loop spins React forever, so the suite hangs instead of failing — the
 * bounded version turns that into a legible assertion failure.
 */
function boundedDetail(limit = 2) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls > limit) return { data: null, mode: "empty" as const, error: null };
    return { data: item(), mode: "remote" as const, error: null };
  };
}

function item(overrides: Partial<VodItem> = {}): VodItem {
  return {
    id: "vod-1",
    sourceKey: "cms-main",
    sourceName: "主用影视源",
    name: "示例剧",
    poster: "",
    description: "",
    year: "2026",
    area: "",
    categories: [],
    actors: [],
    directors: [],
    playLines: [
      {
        id: "line-1",
        name: "线路一",
        episodes: [
          { id: "ep-1", name: "第01集", url: "https://cdn/1.m3u8" },
          { id: "ep-2", name: "第02集", url: "https://cdn/2.m3u8" },
          { id: "ep-3", name: "第03集", url: "https://cdn/3.m3u8" },
        ],
      },
    ],
    ...overrides,
  };
}

function favorite(overrides: Partial<VodFavorite> = {}): VodFavorite {
  return {
    key: "cms-main:vod-1",
    item: item(),
    sourceKey: "cms-main",
    sourceName: "主用影视源",
    savedAt: "2026-01-01T00:00:00.000Z",
    progress: null,
    ...overrides,
  };
}

describe("FavoritesView", () => {
  afterEach(cleanup);

  beforeEach(() => {
    getVodDetail.mockReset();
    searchVod.mockReset();
    resolvePlayback.mockReset();
    getVodDetail.mockResolvedValue({ data: null, mode: "empty", error: null });
    searchVod.mockResolvedValue({
      data: {
        sourceKey: "cms-main",
        items: [],
        categories: [],
        page: 1,
        pageCount: 1,
        pageSize: 10,
        total: 0,
      },
      mode: "empty",
      error: null,
    });
    resolvePlayback.mockResolvedValue({
      url: "https://cdn/1.m3u8",
      mediaKind: "hls",
      adapterId: "direct-http",
    });
    useAppStore.setState({
      sources: [source()],
      favorites: [],
      liveFavorites: [],
      normalizedConfig: "",
    });
  });

  it("separates 影视 from 电视直播 into their own columns", async () => {
    // They are different things with different affordances: one resumes an episode, the other
    // just starts a stream. A single grid made half the cards behave unlike the other half.
    useAppStore.setState({ favorites: [favorite()], liveFavorites: [] });
    render(<FavoritesView onNavigate={() => {}} />);

    // Both columns are present at once, rather than one hiding behind a tab.
    const vodColumn = screen.getByRole("region", { name: "影视收藏" });
    const liveColumn = screen.getByRole("region", { name: "电视直播收藏" });
    expect(vodColumn).toHaveTextContent("示例剧");
    expect(liveColumn).not.toHaveTextContent("示例剧");
    // The empty side still explains itself.
    expect(liveColumn).toHaveTextContent("还没有收藏频道");
  });

  it("keeps an empty column visible and offers the way in", () => {
    // Collapsing it would leave the page looking half-built, and the reader could not tell
    // whether the app had lost their collection or simply had none.
    useAppStore.setState({ favorites: [favorite()], liveFavorites: [] });
    render(<FavoritesView onNavigate={() => {}} />);

    expect(
      screen.getByRole("button", { name: "前往电视直播" }),
    ).toBeInTheDocument();
  });

  it("opens a work from its own row without a tab switch", async () => {
    useAppStore.setState({ favorites: [favorite()], liveFavorites: [] });
    render(<FavoritesView onNavigate={() => {}} />);

    fireEvent.click(screen.getByText("示例剧"));

    expect(await screen.findByTestId("media-player")).toHaveTextContent("示例剧");
  });

  it("lays the works out as a poster grid, not a list", () => {
    // A row spent a whole line of height on one title and showed only a handful at once, which is
    // the wrong trade for a collection you scan. The grid matches 影视库 because recognising a
    // work by its cover is the same task.
    useAppStore.setState({
      favorites: [
        favorite(),
        favorite({ key: "cms-main:vod-2", item: item({ id: "vod-2", name: "第二部" }) }),
      ],
    });
    render(<FavoritesView onNavigate={() => {}} />);

    const column = screen.getByRole("region", { name: "影视收藏" });
    const grid = column.querySelector("div[class*='grid-cols-3']");
    expect(grid).not.toBeNull();
    // Both covers are direct children of that one grid, so they flow left-to-right and wrap.
    expect(grid?.children).toHaveLength(2);
  });

  it("puts only the title, the position and the removal control on a card", () => {
    // The source, the line and the episode count were all on the row version; none of them help
    // you find the work you are looking for.
    useAppStore.setState({
      favorites: [
        favorite({
          progress: {
            lineId: "line-1",
            episodeId: "ep-2",
            episodeName: "第02集",
            seconds: 620,
            episodeCount: 3,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      ],
    });
    render(<FavoritesView onNavigate={() => {}} />);

    const card = screen.getByRole("button", { name: "继续观看 示例剧" });
    expect(card).toHaveTextContent("示例剧");
    expect(card).toHaveTextContent(/第02集/);
    expect(card).toHaveTextContent(/10:20/);
    // The source name is gone from the card.
    expect(card).not.toHaveTextContent("主用影视源");
    // The removal control is inside the card, on the cover.
    expect(
      card.querySelector("button[aria-label='取消收藏 示例剧']"),
    ).not.toBeNull();
  });

  it("says 未观看 on a card that has no saved position", () => {
    useAppStore.setState({ favorites: [favorite({ progress: null })] });
    render(<FavoritesView onNavigate={() => {}} />);

    expect(
      screen.getByRole("button", { name: "继续观看 示例剧" }),
    ).toHaveTextContent("未观看");
  });

  it("lays the channels out in the same grid", () => {
    // A different shape for channels would break the grid's rhythm for an asset the source may
    // not even provide.
    useAppStore.setState({
      liveFavorites: [
        {
          key: "live-main:News:City News",
          channel: {
            id: "live-main:News:City News",
            name: "City News",
            groupId: "news",
            groupName: "新闻",
            logoUrl: "",
            streamUrl: "https://stream.example/news.m3u8",
            streamUrls: ["https://stream.example/news.m3u8"],
            mediaKind: "hls",
            sourceKey: "live-main",
          },
          sourceKey: "live-main",
          sourceName: "直播源",
          savedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    render(<FavoritesView onNavigate={() => {}} />);

    const column = screen.getByRole("region", { name: "电视直播收藏" });
    expect(
      column.querySelector("div[class*='grid-cols-3']"),
    ).not.toBeNull();
    expect(column).toHaveTextContent("City News");
    expect(column).toHaveTextContent("新闻");
  });

  it("shows where the user left off, not just the source name", async () => {
    // The position is the single most useful thing on the card: it is what makes resuming a
    // decision the user does not have to make.
    useAppStore.setState({
      favorites: [
        favorite({
          progress: {
            lineId: "line-1",
            episodeId: "ep-2",
            episodeName: "第02集",
            seconds: 620,
            episodeCount: 3,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      ],
    });
    render(<FavoritesView onNavigate={() => {}} />);

    expect(screen.getByText(/第02集/)).toBeInTheDocument();
    expect(screen.getByText(/10:20/)).toBeInTheDocument();
  });

  it("plays the saved episode straight from the favourites page", async () => {
    // The old page navigated to 影视库 and made it find the work again, which failed outright
    // when the source it came from had been deleted.
    useAppStore.setState({
      favorites: [
        favorite({
          progress: {
            lineId: "line-1",
            episodeId: "ep-2",
            episodeName: "第02集",
            seconds: 120,
            episodeCount: 3,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      ],
    });
    render(<FavoritesView onNavigate={() => {}} />);

    fireEvent.click(screen.getByText("示例剧"));

    // The rail lists every episode and the saved one is playing, without a navigation.
    expect(await screen.findByText("共 3 集")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /第02集/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(await screen.findByTestId("media-player")).toHaveTextContent(
      "示例剧 · 第02集",
    );
  });

  it("starts at the first episode when nothing has been watched", async () => {
    useAppStore.setState({ favorites: [favorite({ progress: null })] });
    render(<FavoritesView onNavigate={() => {}} />);

    fireEvent.click(screen.getByText("示例剧"));

    expect(await screen.findByRole("button", { name: /第01集/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("plays from the snapshot when the original source is gone", async () => {
    // This is the whole point of storing the work whole: the favourite has to survive the source
    // being deleted, renamed or reordered.
    useAppStore.setState({
      sources: [],
      favorites: [favorite({ sourceKey: "deleted-source" })],
    });
    render(<FavoritesView onNavigate={() => {}} />);

    fireEvent.click(screen.getByText("示例剧"));

    // Playback still happens, from the saved address.
    expect(await screen.findByTestId("media-player")).toHaveTextContent("示例剧");
    await waitFor(() => {
      // The third argument opts into scanning the address when it turns out to be a player page
      // rather than a media file, which is how most ordinary CMS episodes are delivered.
      expect(resolvePlayback).toHaveBeenCalledWith(
        "https://cdn/1.m3u8",
        expect.anything(),
        true,
      );
    });
  });

  it("relinks to another source when the original cannot supply the work", async () => {
    // Asking the user to go and find it again defeats the point of favouriting it, so the
    // replacement happens silently and is reported as a note.
    const other = source({ key: "cms-backup", name: "备用影视源" });
    useAppStore.setState({
      sources: [source(), other],
      favorites: [favorite()],
    });
    getVodDetail.mockResolvedValue({
      data: null,
      mode: "empty",
      error: "源已失效",
    });
    // The search row carries a single line; the detail request has the full set. Relinking on
    // the search row alone is why a relinked favourite offered nothing to switch to.
    const searchRow = item({
      id: "vod-1",
      sourceKey: "cms-backup",
      playLines: [
        {
          id: "line-1",
          name: "线路一",
          episodes: [{ id: "ep-1", name: "第01集", url: "https://cdn/1.m3u8" }],
        },
      ],
    });
    const fullDetail = item({
      id: "vod-1",
      sourceKey: "cms-backup",
      playLines: [
        {
          id: "line-1",
          name: "线路一",
          episodes: [{ id: "ep-1", name: "第01集", url: "https://cdn/1.m3u8" }],
        },
        {
          id: "line-2",
          name: "线路二",
          episodes: [{ id: "ep-1b", name: "第01集", url: "https://cdn/b1.m3u8" }],
        },
      ],
    });
    searchVod.mockResolvedValue({
      data: {
        sourceKey: "cms-backup",
        items: [searchRow],
        categories: [],
        page: 1,
        pageCount: 1,
        pageSize: 10,
        total: 1,
      },
      mode: "remote",
      error: null,
    });
    // The first call is for the original source (fails), the second for the relinked one.
    getVodDetail
      .mockResolvedValueOnce({ data: null, mode: "empty", error: "源已失效" })
      .mockResolvedValue({ data: fullDetail, mode: "remote", error: null });

    render(<FavoritesView onNavigate={() => {}} />);
    fireEvent.click(screen.getByText("示例剧"));

    await waitFor(() => {
      expect(screen.getByText(/已自动切换到「备用影视源」/)).toBeInTheDocument();
    });
    // Both of the new source's lines are offered, not just the one the search row carried.
    expect(
      await screen.findByRole("button", { name: /线路 2：线路二/ }),
    ).toBeInTheDocument();
  });

  it("says so plainly when no other source has the work", async () => {
    useAppStore.setState({
      sources: [source({ key: "cms-backup", name: "备用影视源" })],
      favorites: [favorite()],
    });
    getVodDetail.mockResolvedValue({ data: null, mode: "empty", error: null });
    searchVod.mockResolvedValue({
      data: {
        sourceKey: "cms-backup",
        items: [],
        categories: [],
        page: 1,
        pageCount: 1,
        pageSize: 10,
        total: 0,
      },
      mode: "empty",
      error: null,
    });

    render(<FavoritesView onNavigate={() => {}} />);
    fireEvent.click(screen.getByText("示例剧"));

    await waitFor(() => {
      expect(screen.getByText(/也没有找到这部作品/)).toBeInTheDocument();
    });
    // The saved address is still what plays, so the page is not left broken.
    expect(await screen.findByTestId("media-player")).toBeInTheDocument();
  });

  it("opens a favourited channel in the favourites page", async () => {
    useAppStore.setState({
      liveFavorites: [
        {
          key: "live-main:News:City News",
          channel: {
            id: "live-main:News:City News",
            name: "City News",
            groupId: "news",
            groupName: "新闻",
            logoUrl: "",
            streamUrl: "https://stream.example/news.m3u8",
            streamUrls: ["https://stream.example/news.m3u8"],
            mediaKind: "hls",
            sourceKey: "live-main",
          },
          sourceKey: "live-main",
          sourceName: "直播源",
          savedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    render(<FavoritesView onNavigate={() => {}} />);

    // Both columns are on screen, so the channel is reachable without switching anything.
    const card = await screen.findByText("City News");
    fireEvent.click(card);

    // Watching happens here, without going back to the live page.
    expect(await screen.findByTestId("media-player")).toHaveTextContent("City News");
  });

  it("offers a line switcher when the work carries several lines", async () => {
    // A relinked favourite arrives with whatever the new source has, and lines are not
    // equivalent, so the rail has to say which one is playing and allow changing it.
    const twoLine = item({
      playLines: [
        {
          id: "line-1",
          name: "线路一",
          episodes: [
            { id: "ep-1", name: "第01集", url: "https://cdn/a1.m3u8" },
            { id: "ep-2", name: "第02集", url: "https://cdn/a2.m3u8" },
          ],
        },
        {
          id: "line-2",
          name: "线路二",
          episodes: [
            { id: "ep-1b", name: "第01集", url: "https://cdn/b1.m3u8" },
            { id: "ep-2b", name: "第02集", url: "https://cdn/b2.m3u8" },
          ],
        },
      ],
    });
    useAppStore.setState({
      favorites: [
        favorite({
          item: twoLine,
          progress: {
            lineId: "line-1",
            episodeId: "ep-2",
            episodeName: "第02集",
            seconds: 60,
            episodeCount: 2,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      ],
    });
    render(<FavoritesView onNavigate={() => {}} />);
    fireEvent.click(screen.getByText("示例剧"));

    const line2 = await screen.findByRole("button", { name: /线路 2：线路二/ });
    fireEvent.click(line2);

    // The place is kept by episode name, because the other line numbers its episodes
    // independently.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /第02集/ })).toHaveAttribute(
        "aria-current",
        "true",
      );
    });
    expect(resolvePlayback).toHaveBeenCalledWith(
      "https://cdn/b2.m3u8",
      expect.anything(),
      true,
    );
  });

  it("hides the line switcher for a single-line work", async () => {
    // One line is not a choice; a lone button would suggest otherwise.
    useAppStore.setState({ favorites: [favorite()] });
    render(<FavoritesView onNavigate={() => {}} />);
    fireEvent.click(screen.getByText("示例剧"));

    await screen.findByTestId("media-player");
    expect(screen.queryByRole("button", { name: /线路 1：/ })).toBeNull();
  });

  it("offers 播放诊断 from the player itself", async () => {
    // Without it a player stuck on "正在准备播放" gave no way to find out why.
    useAppStore.setState({ favorites: [favorite()] });
    render(<FavoritesView onNavigate={() => {}} />);
    fireEvent.click(screen.getByText("示例剧"));

    const trigger = await screen.findByRole("button", { name: "播放诊断" });
    fireEvent.click(trigger);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("does not refetch the detail in a loop while the work is open", async () => {
    // The refresh effect both read `favorite.item` and wrote it back through the store, so it
    // re-triggered itself forever: each pass produced a new `item`, which handed the player a new
    // `episode` object and reset it before it could start. That is what left the surface spinning
    // on "正在准备播放" and made the picture flash and vanish.
    useAppStore.setState({ favorites: [favorite()] });
    // A fresh object per call, which is what a real request returns — a shared object would keep
    // `favorite.item` identical and hide the loop entirely.
    //
    // After two calls the mock stops returning data, which is what makes a regression terminate
    // instead of spinning React forever: with no data there is no store write, so the cycle has
    // nothing to feed it and the test fails on the count rather than hanging the runner.
    getVodDetail.mockImplementation(boundedDetail(2));

    render(<FavoritesView onNavigate={() => {}} />);
    fireEvent.click(screen.getByText("示例剧"));
    await screen.findByTestId("media-player");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    // One fetch per open. A third call means the refresh re-triggered itself.
    expect(getVodDetail.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("does not refetch the detail while progress is being reported", async () => {
    // The refresh effect depends on `setItemWithProgress`, and that callback closed over
    // `favorite.progress` — which the store replaces on every progress tick. A callback that gets
    // a new identity every few seconds makes the effect re-run just as often, refetching the
    // detail mid-playback on a timer.
    useAppStore.setState({ favorites: [favorite()] });
    getVodDetail.mockImplementation(boundedDetail(2));

    render(<FavoritesView onNavigate={() => {}} />);
    fireEvent.click(screen.getByText("示例剧"));
    await screen.findByTestId("media-player");

    const report = (
      globalThis as { __favPlayerOnProgress?: (s: number) => void }
    ).__favPlayerOnProgress;
    expect(report).toBeTypeOf("function");

    await act(async () => {
      for (let seconds = 10; seconds <= 60; seconds += 10) {
        report?.(seconds);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    // Progress ticks must not each trigger a detail fetch.
    expect(getVodDetail.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("does not restart the player when the episode list is refreshed", async () => {
    // Refreshing replaces the episode objects, so an effect keyed on the object tears the player
    // down and resolves the address again — the picture appears and then snaps back.
    useAppStore.setState({ favorites: [favorite()] });
    getVodDetail.mockImplementation(boundedDetail(2));

    render(<FavoritesView onNavigate={() => {}} />);
    fireEvent.click(screen.getByText("示例剧"));
    await screen.findByTestId("media-player");

    // Wait for the refresh to have replaced the episode list underneath the player.
    await waitFor(() => {
      expect(useAppStore.getState().favorites[0].item.name).toBe("示例剧");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // The address was resolved once for this episode; a restart would resolve it again.
    expect(resolvePlayback.mock.calls.length).toBe(1);
    expect(screen.getByTestId("media-player")).toBeInTheDocument();
  });

  it("keeps the player mounted when it reports an ordinary status", async () => {
    // The player's status messages were written to the same state as the resolve failure, so any
    // message — including an ordinary "正在连接" — replaced the player with the failure screen.
    useAppStore.setState({ favorites: [favorite()] });
    render(<FavoritesView onNavigate={() => {}} />);
    fireEvent.click(screen.getByText("示例剧"));

    await screen.findByTestId("media-player");
    const onStatus = (
      globalThis as { __favPlayerOnStatus?: (s: string, m?: string) => void }
    ).__favPlayerOnStatus;
    expect(onStatus).toBeTypeOf("function");
    act(() => {
      onStatus?.("loading", "正在连接直播信号");
    });

    // Still a player, not the failure screen.
    expect(screen.getByTestId("media-player")).toBeInTheDocument();
    expect(screen.queryByText("无法播放当前内容")).toBeNull();
  });

  it("offers a way to the library when there is nothing favourited", () => {
    const onNavigate = vi.fn();
    render(<FavoritesView onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "浏览影视库" }));
    expect(onNavigate).toHaveBeenCalledWith("browse");
  });
});
