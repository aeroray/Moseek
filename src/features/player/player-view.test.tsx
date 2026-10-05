import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlayerView } from "@/features/player/player-view";
import type { SourceRecord, VodEpisode, VodItem } from "@/types/moseek";

const resolvePlayback = vi.fn();
const getVodDetail = vi.fn();

// Plyr + hls.js need a real media element; this suite covers the page's own composition.
vi.mock("@/features/player/media-player", () => ({
  MediaPlayer: ({
    title,
    url,
    isLive,
    onPlayable,
    onStatus,
  }: {
    title: string;
    url: string;
    isLive?: boolean;
    onPlayable?: () => void;
    onStatus?: (status: string, message?: string) => void;
  }) => (
    <div
      data-testid="media-player"
      data-url={url}
      data-autoplay={isLive ? "true" : "false"}
    >
      {title}
      <button type="button" onClick={() => onPlayable?.()}>
        模拟可播放
      </button>
      {/* The footprint is gated on real playback, so the test has to be able to report it. */}
      <button type="button" onClick={() => onStatus?.("playing")}>
        模拟播放中
      </button>
    </div>
  ),
  usesHlsPipeline: () => true,
}));

vi.mock("@/features/browse/cms-adapter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/browse/cms-adapter")>();
  return {
    ...actual,
    getVodDetail: (...args: unknown[]) => getVodDetail(...args),
  };
});

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
    poster: "https://img.example/poster.jpg",
    description: "简介",
    year: "2026",
    area: "中国大陆",
    categories: [{ id: "cat-1", name: "剧情" }],
    actors: [],
    directors: [],
    playLines: [
      { id: "line-1", name: "dyttm3u8", episodes },
      { id: "line-2", name: "dytt", episodes: episodes.slice(0, 5) },
    ],
  };
}

function renderPlayer() {
  return render(
    <PlayerView item={item()} source={source()} onBack={() => {}} />,
  );
}

describe("PlayerView composition", () => {
  afterEach(cleanup);

  beforeEach(() => {
    resolvePlayback.mockReset();
    resolvePlayback.mockImplementation(async (url: string) => ({
      url,
      mediaKind: "hls",
      adapterId: "test",
    }));
    getVodDetail.mockReset();
    getVodDetail.mockImplementation(async (_source, vod: VodItem) => ({
      data: vod,
      mode: "remote",
      error: null,
    }));
    useAppStore.setState({ playbackProgress: {}, history: [], favorites: [] });
  });

  it("leads the metadata block with the work's name", async () => {
    // The title used to sit in the toolbar, which made the work read as chrome around the
    // player. It now opens the metadata block below the player, so the eye lands on the work.
    renderPlayer();

    const heading = await screen.findByRole("heading", { name: SHOW });
    expect(heading.tagName).toBe("H1");
    expect(screen.queryByText("播放器视窗")).not.toBeInTheDocument();

    // It is below the player, not inside the toolbar.
    const player = await screen.findByTestId("media-player");
    expect(
      player.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.querySelector("header")?.contains(heading)).toBe(false);
  });

  it("does not repeat the episode name and index under the player", async () => {
    // The row carried "第01集 （1 / 24）" beside the stepper, which the highlighted entry in the
    // rail already states.
    renderPlayer();

    const player = await screen.findByTestId("media-player");
    const column = player.parentElement;
    expect(column?.textContent).not.toMatch(/（\d+ \/ \d+）/);
  });

  it("does not record a footprint just because the work was opened", async () => {
    // The record used to be written on entry, before a byte of media was fetched and without the
    // user pressing play, so 足迹 filled with works that were merely looked at — each with a
    // position of 0. Opening a page is not watching something.
    renderPlayer();
    await screen.findByTestId("media-player");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(useAppStore.getState().history).toHaveLength(0);
  });

  it("records the footprint once playback has actually started", async () => {
    renderPlayer();
    await screen.findByTestId("media-player");

    // Nothing yet: the player exists but has not produced a picture.
    expect(useAppStore.getState().history).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "模拟播放中" }));

    await waitFor(() => {
      const history = useAppStore.getState().history;
      expect(history).toHaveLength(1);
      expect(history[0].kind).toBe("vod");
    });
    const record = useAppStore.getState().history[0];
    if (record.kind !== "vod") throw new Error("expected a vod footprint");
    expect(record.item.name).toBe(SHOW);
    expect(record.episodeName).toBe("第01集");
  });

  it("does not rewrite the footprint on every progress tick", async () => {
    // `playbackProgress` is in the effect's dependencies, so without the guard every position
    // update re-runs the effect and rewrites the record — bumping `updatedAt` continuously and
    // persisting the whole store each time. The store dedupes by id, so the row count alone
    // cannot see this; the timestamp can.
    renderPlayer();
    await screen.findByTestId("media-player");
    fireEvent.click(screen.getByRole("button", { name: "模拟播放中" }));
    await waitFor(() => expect(useAppStore.getState().history).toHaveLength(1));

    const first = useAppStore.getState().history[0].updatedAt;
    await act(async () => {
      // Simulate the player reporting its position, as it does every few seconds.
      useAppStore.getState().setPlaybackProgress("vod-1:ep-1", 120);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(useAppStore.getState().history).toHaveLength(1);
    expect(useAppStore.getState().history[0].updatedAt).toBe(first);
  });

  it("clamps the synopsis so a long one cannot force a scrollbar", async () => {
    // The column must fit the viewport: a full synopsis used to push the page into scrolling.
    renderPlayer();

    const description = await screen.findByText("简介");
    expect(description.className).toContain("line-clamp-3");
  });

  it("attaches the full synopsis as a tooltip when the clamp hides text", async () => {
    // The clamp hides text, so the tooltip is what makes it lossless. jsdom reports zero
    // heights, which the overflow check treats as "there is more to show", so the paragraph is
    // rendered as a tooltip trigger here. (Radix mounts the content lazily, on open, so only the
    // trigger is asserted.)
    renderPlayer();

    const description = await screen.findByText("简介");
    expect(description).toHaveAttribute("data-slot", "tooltip-trigger");
    expect(description.className).toContain("cursor-help");
  });

  it("shows a loading placeholder until the media reports it can play", async () => {
    // Plyr builds its DOM and reports "ready" before any media is fetched, so a page that
    // reveals the player then shows a working-looking surface for a URL that fails seconds
    // later. The surface must stay a loading state until the element can actually play.
    renderPlayer();

    expect(await screen.findByText("正在确认可以播放…")).toBeInTheDocument();
    // The player is mounted underneath so it can do its work, but not shown yet.
    expect(screen.getByTestId("media-player")).toBeInTheDocument();
  });

  it("starts the player on a user action rather than by itself", async () => {
    // The user's complaint was that opening a work appeared to start playing on its own. Measured
    // in a real browser, the media element is not given `autoplay` and its `currentTime` stays at
    // 0 — but the page must also not ask it to play, which is what this locks: the controls are
    // live and the first frame arrives, yet nothing requests playback.
    renderPlayer();
    await screen.findByTestId("media-player");

    expect(screen.getByTestId("media-player")).toHaveAttribute(
      "data-autoplay",
      "false",
    );
  });

  it("reveals the player once the media reports it can play", async () => {
    // The counterpart to the loading test: playability is what swaps the placeholder for the
    // real surface.
    renderPlayer();

    expect(await screen.findByText("正在确认可以播放…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "模拟可播放" }));

    await waitFor(() => {
      expect(screen.queryByText("正在确认可以播放…")).not.toBeInTheDocument();
    });
    const wrapper = screen.getByTestId("media-player").parentElement;
    expect(wrapper?.className).not.toContain("hidden");
  });

  it("takes over the surface with the reason when playback fails", async () => {
    // The failure banner under the player was removed: the surface itself now states the
    // reason, which is where the user is already looking.
    resolvePlayback.mockRejectedValue(new Error("上游拒绝访问当前地址"));
    renderPlayer();

    expect(await screen.findByText("无法播放当前内容")).toBeInTheDocument();
    expect(screen.getAllByText(/上游拒绝访问当前地址/).length).toBeGreaterThan(0);
    // The old banner is gone.
    expect(screen.queryByText("播放失败")).not.toBeInTheDocument();
    // A retry is offered on the surface.
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("shows the backend's own reason when a Tauri command rejects with a string", async () => {
    // A Tauri command returning `Err(String)` rejects its JS promise with a plain string, not an
    // Error. `error instanceof Error` is therefore false for every backend failure, and the old
    // `instanceof Error ? error.message : "播放地址未通过安全检查"` discarded the real reason and
    // showed the fallback instead — which is how "播放地址未通过安全检查" reached the user while
    // fifty-five parser services had actually failed and timed out.
    resolvePlayback.mockRejectedValue(
      "已尝试 12 个解析服务，但没有一个返回可播放地址。请更换线路或影视源。",
    );
    renderPlayer();

    expect(await screen.findByText("无法播放当前内容")).toBeInTheDocument();
    expect(
      screen.getAllByText(/已尝试 12 个解析服务，但没有一个返回可播放地址/).length,
    ).toBeGreaterThan(0);
    // The misleading fallback must not be shown in its place.
    expect(
      screen.queryByText("播放地址未通过安全检查"),
    ).not.toBeInTheDocument();
  });

  it("fills the surface with a placeholder when the source has no episodes", async () => {
    // A small grey box floating in a large empty area read as a broken layout. The empty state
    // now occupies the whole surface.
    getVodDetail.mockResolvedValue({
      data: { ...item(), playLines: [] },
      mode: "remote",
      error: null,
    });
    render(
      <PlayerView
        item={{ ...item(), playLines: [] }}
        source={source()}
        onBack={() => {}}
      />,
    );

    // The empty state is a claim about the source, so it is only made once the detail request has
    // answered — see the test below for what is shown before that.
    expect(await screen.findByText("暂无可播放的剧集")).toBeInTheDocument();
    expect(screen.getByText(/未解析出播放线路或剧集/)).toBeInTheDocument();
    // The rail says why it is empty instead of rendering a blank card.
    expect(screen.getByText("没有可用线路")).toBeInTheDocument();
  });

  it("does not claim the source is empty before the detail request answers", async () => {
    // The reported flash: opening a work showed 暂无可播放的剧集, which then vanished into a loading
    // state and finally played, while the play-line rail sat empty and then filled. The cause was
    // that a slim catalog row and a source with nothing to offer looked identical, so the empty
    // state was rendered during the round trip. A deferred promise reproduces that window exactly.
    let release: (value: unknown) => void = () => {};
    getVodDetail.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(
      <PlayerView
        item={{ ...item(), playLines: [] }}
        source={source()}
        onBack={() => {}}
      />,
    );

    // While the answer is outstanding: a loading state, and NO claim about the source.
    expect(screen.getByText("正在获取剧集…")).toBeInTheDocument();
    expect(screen.getByText("正在获取播放线路…")).toBeInTheDocument();
    expect(screen.queryByText("暂无可播放的剧集")).not.toBeInTheDocument();
    expect(screen.queryByText("没有可用线路")).not.toBeInTheDocument();
    // The rail header must not state "0 线路 · 0 集" either, which is about to be contradicted.
    expect(screen.getByText("正在获取…")).toBeInTheDocument();

    // The detail arrives with real lines: the loading state gives way to the player, and the empty
    // state is never shown at any point.
    release({
      data: {
        ...item(),
        playLines: [
          {
            id: "line-1",
            name: "线路一",
            episodes: [{ id: "ep-1", name: "第 1 集", url: "https://example.com/a.m3u8" }],
          },
        ],
      },
      mode: "remote",
      error: null,
    });

    expect(await screen.findByText(/线路一/)).toBeInTheDocument();
    expect(screen.queryByText("暂无可播放的剧集")).not.toBeInTheDocument();
    expect(screen.queryByText("没有可用线路")).not.toBeInTheDocument();
  });

  it("labels the back control with the word, not only an icon", () => {
    // The bare chevron saved the width of one word and cost the meaning: this header has no title
    // in it, so the arrow was the only thing saying how to leave the page. The visible word is the
    // accessible name too, so the two can never disagree.
    renderPlayer();

    const back = screen.getByRole("button", { name: "返回列表" });
    expect(back.textContent).toContain("返回列表");
    expect(back.querySelector(".lucide-chevron-left")).toBeTruthy();
    expect(document.querySelector("header")?.textContent).toContain("返回列表");
  });

  it("draws no divider in the header", () => {
    // With the title moved out, the header is just a back button and a favourite button. The
    // separator that used to divide the back button from the title was a line drawn against
    // empty space.
    renderPlayer();

    const header = document.querySelector("header");
    const dividers = [...(header?.querySelectorAll("div") ?? [])].filter((node) =>
      node.className.includes("w-px"),
    );
    expect(dividers).toHaveLength(0);
  });

  it("removes the source/line/episode sub-line from the header", () => {
    // The same facts are already visible in the episode rail and on the player itself.
    renderPlayer();

    const header = document.querySelector("header");
    expect(header?.textContent).not.toContain("电影天堂");
    expect(header?.textContent).not.toContain("dyttm3u8");
  });

  it("starts playing the first episode without a navigation", async () => {
    // Detail and playback are one page now: opening a work must already be playing, which is
    // the whole point of merging them.
    renderPlayer();

    const player = await screen.findByTestId("media-player");
    expect(player).toHaveAttribute("data-url", episodes[0].url);
    expect(resolvePlayback).toHaveBeenCalled();
  });

  it("swaps the stream in place when another episode is picked", async () => {
    renderPlayer();

    const player = await screen.findByTestId("media-player");
    expect(player).toHaveAttribute("data-url", episodes[0].url);

    fireEvent.click(screen.getByRole("button", { name: "第05集" }));

    const swapped = await screen.findByTestId("media-player");
    expect(swapped).toHaveAttribute("data-url", episodes[4].url);
  });

  it("keeps the episode rail and the work's metadata on the same page", async () => {
    renderPlayer();

    // The rail is what makes in-place switching possible.
    expect(screen.getByText("线路与选集")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "第24集" })).toBeInTheDocument();
    // The metadata moved here from the deleted detail page rather than being dropped.
    expect(screen.getByText("简介")).toBeInTheDocument();
    expect(screen.getByText("2026")).toBeInTheDocument();
    expect(screen.getByText("中国大陆")).toBeInTheDocument();
    expect(screen.getByText("来源：电影天堂")).toBeInTheDocument();
  });

  it("moves the episode stepper below the player", async () => {
    // 上一集/下一集 sat in the header next to the title, far from the picture they change.
    renderPlayer();

    const header = document.querySelector("header");
    expect(header?.textContent).not.toContain("上一集");
    expect(header?.textContent).not.toContain("下一集");

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

  it("adopts the fuller play lines the detail request returns", async () => {
    // The catalog row is a summary. When the detail request comes back with more episodes, the
    // rail must show them and the player must follow the new first episode.
    const detail = item();
    detail.playLines = [
      { id: "line-1", name: "dyttm3u8", episodes },
      { id: "line-2", name: "dytt", episodes: episodes.slice(0, 5) },
    ];
    getVodDetail.mockResolvedValue({ data: detail, mode: "remote", error: null });

    render(
      <PlayerView
        item={{ ...item(), playLines: [{ id: "line-1", name: "dyttm3u8", episodes: episodes.slice(0, 2) }] }}
        source={source()}
        onBack={() => {}}
      />,
    );

    // Starts from the catalog row's two episodes...
    expect(await screen.findByRole("button", { name: "第24集" })).toBeInTheDocument();
  });
});
