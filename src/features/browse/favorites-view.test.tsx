import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/features/player/media-player", () => ({
  MediaPlayer: ({ title }: { title: string }) => (
    <div data-testid="media-player">{title}</div>
  ),
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

  it("separates 影视 from 电视直播 instead of mixing them in one grid", async () => {
    // They are different things with different affordances: one resumes an episode, the other
    // just starts a stream. A single grid made half the cards behave unlike the other half.
    useAppStore.setState({ favorites: [favorite()], liveFavorites: [] });
    render(<FavoritesView onNavigate={() => {}} />);

    expect(screen.getByRole("tab", { name: /影视/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /电视直播/ })).toBeInTheDocument();
    expect(screen.getByText("示例剧")).toBeInTheDocument();
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
      expect(resolvePlayback).toHaveBeenCalledWith(
        "https://cdn/1.m3u8",
        expect.anything(),
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

    // Radix switches tabs on pointer-down, not click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: /电视直播/ }), {
      button: 0,
    });
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

  it("offers a way to the library when there is nothing favourited", () => {
    const onNavigate = vi.fn();
    render(<FavoritesView onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "浏览影视库" }));
    expect(onNavigate).toHaveBeenCalledWith("browse");
  });
});
