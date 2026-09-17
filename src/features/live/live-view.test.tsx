import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveView } from "@/features/live/live-view";
import type { EpgCatalog, LiveCatalog, SourceRecord } from "@/types/moseek";

const loadLiveCatalog = vi.fn();
const loadEpg = vi.fn();

// The pure helpers are reused rather than stubbed: the view depends on template
// substitution and on picking the currently-airing programme.
vi.mock("@/lib/live-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/live-adapter")>();
  return {
    ...actual,
    loadLiveCatalog: (...args: unknown[]) => loadLiveCatalog(...args),
    loadEpg: (...args: unknown[]) => loadEpg(...args),
  };
});

// The player pulls in Plyr and hls.js, which need a real media element. This suite is
// about the live workspace's own render contract, so the player is replaced by a stub.
vi.mock("@/features/player/media-player", () => ({
  MediaPlayer: ({ title }: { title: string }) => (
    <div data-testid="media-player">{title}</div>
  ),
  usesHlsPipeline: () => true,
}));

// The panel is replaced by a stub that still renders its note, so tests can assert what the
// diagnosis says without pulling in the whole diagnostic report builder.
vi.mock("@/features/player/media-diagnostic-panel", () => ({
  MediaDiagnosticPanel: ({ note }: { note?: string | null }) => (
    <div data-testid="diagnostic-panel">{note}</div>
  ),
}));

const probeStreamUrls = vi.fn();

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauriRuntime: () => true,
    resolvePlayback: async (url: string) => ({
      url,
      mediaKind: "hls",
      adapterId: "test",
    }),
    probeStreamUrls: (...args: unknown[]) => probeStreamUrls(...args),
  };
});

const { useAppStore } = await import("@/stores/app-store");

function liveSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    key: "live-main",
    name: "主用直播源",
    sourceType: "live",
    api: "https://live.example/channels.m3u",
    epg: "https://live.example/epg.xml",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "demo",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
    ...overrides,
  };
}

const catalog: LiveCatalog = {
  channels: [
    {
      id: "live-main:News:City News",
      name: "City News",
      groupId: "news",
      groupName: "News",
      logoUrl: "",
      streamUrl: "https://stream.example/news.m3u8",
      streamUrls: ["https://stream.example/news.m3u8"],
      mediaKind: "hls",
      sourceKey: "live-main",
      epgId: "news.one",
    },
  ],
  groups: [{ id: "news", name: "News" }],
};

/** A channel with three lines, for the concurrent line-probe behaviour. */
const multiLineCatalog: LiveCatalog = {
  channels: [
    {
      id: "live-main:News:City News",
      name: "City News",
      groupId: "news",
      groupName: "News",
      logoUrl: "",
      streamUrl: "https://stream.example/line-1.m3u8",
      streamUrls: [
        "https://stream.example/line-1.m3u8",
        "https://stream.example/line-2.m3u8",
        "https://stream.example/line-3.m3u8",
      ],
      mediaKind: "hls",
      sourceKey: "live-main",
      epgId: "news.one",
    },
  ],
  groups: [{ id: "news", name: "News" }],
};

/** Two groups whose names are distinguishable, for the search-scope behaviour. */
const twoGroupCatalog: LiveCatalog = {
  channels: [
    {
      id: "live-main:A:cctv1",
      name: "CCTV-1 综合",
      groupId: "A",
      groupName: "央视频道",
      logoUrl: "",
      streamUrl: "https://stream.example/a1.m3u8",
      streamUrls: ["https://stream.example/a1.m3u8"],
      mediaKind: "hls",
      sourceKey: "live-main",
      epgId: undefined,
    },
    {
      id: "live-main:A:cctv2",
      name: "CCTV-2 财经",
      groupId: "A",
      groupName: "央视频道",
      logoUrl: "",
      streamUrl: "https://stream.example/a2.m3u8",
      streamUrls: ["https://stream.example/a2.m3u8"],
      mediaKind: "hls",
      sourceKey: "live-main",
      epgId: undefined,
    },
    // Only in group B; finding it while group A is selected proves the search spans groups.
    {
      id: "live-main:B:hunan",
      name: "湖南卫视高清",
      groupId: "B",
      groupName: "卫视频道",
      logoUrl: "",
      streamUrl: "https://stream.example/b1.m3u8",
      streamUrls: ["https://stream.example/b1.m3u8"],
      mediaKind: "hls",
      sourceKey: "live-main",
      epgId: undefined,
    },
  ],
  groups: [
    { id: "A", name: "央视频道" },
    { id: "B", name: "卫视频道" },
  ],
};

function probe(index: number, ok: boolean, elapsedMs = 100) {
  return {
    index,
    url: `https://stream.example/line-${index + 1}.m3u8`,
    ok,
    status: ok ? 200 : null,
    contentType: ok ? "application/vnd.apple.mpegurl" : null,
    mediaKind: "hls",
    elapsedMs,
    message: ok ? "可用" : "无法连接",
  };
}

describe("LiveView EPG rendering", () => {
  // This project does not enable vitest `globals`, so Testing Library's automatic cleanup
  // is not registered; without it each render stays mounted and the next query matches
  // several copies of the same control.
  afterEach(cleanup);

  beforeEach(() => {
    loadLiveCatalog.mockReset();
    loadEpg.mockReset();
    loadLiveCatalog.mockResolvedValue({ data: catalog, error: null });
    // The guide must cover the current minute, because the footer now reports the programme
    // actually on air rather than the first row of the day. Build the window around "now".
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    // Offsets may wrap past midnight, which is realistic: a guide that runs late is exactly the
    // case `findNextProgram` has to handle. The fixture keeps the wrap rather than clamping it,
    // so this test covers the boundary instead of failing at it.
    const clock = (offsetMinutes: number) => {
      const at = new Date(now.getTime() + offsetMinutes * 60_000);
      return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    };
    loadEpg.mockResolvedValue({
      data: {
        programs: [
          {
            id: "news.one-0",
            channelId: "news.one",
            title: "Morning News",
            description: "",
            startAt: clock(-30),
            endAt: clock(30),
          },
          {
            id: "news.one-1",
            channelId: "news.one",
            title: "Evening Report",
            description: "",
            startAt: clock(30),
            endAt: clock(90),
          },
        ],
      } satisfies EpgCatalog,
      mode: "remote",
      origin: "configured",
      error: null,
    });
    useAppStore.setState({
      sources: [liveSource()],
      liveFavorites: [],
      autoEpgEnabled: false,
    });
  });

  it("renders the program guide returned by the adapter", async () => {
    // The adapter resolves an EpgCatalog (`{ programs }`), not a bare array. Assigning the
    // whole object to the program list made `epgPrograms.filter` throw during render, which
    // the root Error Boundary surfaced as "Moseek 暂时无法显示这个页面".
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });
    expect(await screen.findByText(/Morning News/)).toBeInTheDocument();
  });

  it("keeps channel selection working after the catalog loads", async () => {
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });
    expect(screen.getByLabelText("下一个频道")).toBeDisabled();
  });

  it("surfaces a live catalog request failure instead of showing an empty list", async () => {
    // Without channels there is nothing to watch, so the reason has to be visible. The raw error
    // text is not shown: a reqwest chain naming DNS and deadlines is not actionable. What the
    // user can act on is stated instead.
    loadLiveCatalog.mockResolvedValue({
      data: { channels: [], groups: [] },
      error: "直播源请求失败",
    });

    render(<LiveView />);

    expect(await screen.findByText("直播源请求失败")).toBeInTheDocument();
    expect(screen.getByText(/无法读取这个直播源的频道列表/)).toBeInTheDocument();
    // The provider's raw message is not surfaced as the user-facing explanation.
    expect(screen.queryByText("直播源请求失败", { selector: "p" })).toBeNull();
  });

  it("lets the channel list scroll instead of growing past its pane", async () => {
    // A flex item defaults to `min-height: auto`, so a `flex-1` scroll root grows to its
    // full content height and its viewport ends up exactly as tall as the content. There is
    // then nothing to scroll and the aside's `overflow-hidden` silently clips the list.
    // jsdom can confirm the class contract that prevents this but not the layout itself.
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });

    const viewport = document.querySelector("[data-radix-scroll-area-viewport]");
    const root = viewport?.parentElement;
    expect(root?.className).toContain("min-h-0");
  });

  it("exposes the group filter as a labelled dropdown", async () => {
    // The filter used to be one chip per group. A playlist can carry dozens of groups, which
    // pushed the bar past the viewport and read as noise; a dropdown keeps the bar a fixed
    // height and scales to any number of groups.
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });

    const trigger = screen.getByLabelText("频道分组");
    expect(trigger).toBeInTheDocument();
    // Radix renders the selected item's text inside the trigger. The default is every group, not
    // the first one: a playlist's first group is an arbitrary slice of it, so opening on it hid
    // most of the channels for no stated reason.
    expect(trigger).toHaveTextContent("全部分组");
    // The old chip row is gone.
    expect(screen.queryByText("分组")).not.toBeInTheDocument();
  });

  it("defaults the group filter to every group, not the first one", async () => {
    // The control used to open on the playlist's first group, which is an arbitrary slice of it
    // and hid most of the channels for no stated reason. This fixture has one group, so the
    // point is that the trigger names the *scope* rather than that group.
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });

    const trigger = screen.getByLabelText("频道分组");
    expect(trigger).toHaveTextContent("全部分组");
    expect(trigger).not.toHaveTextContent("News");
    // With no narrowing, the footer reports the whole catalog without a "filtered" count.
    expect(screen.getByText("1 个频道")).toBeInTheDocument();
  });

  it("groups the source and the group filter on the left with a centred widened search", async () => {
    // The group filter is a scope and belongs beside the source it filters; the search is the
    // term and owns the centre, widened to hold the width the group control gave up.
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });

    const header = document.querySelector("header");
    expect(header).toBeTruthy();
    const zones = [...(header?.children ?? [])] as HTMLElement[];
    // left scope group, centred search, right controls
    const left = zones[0];
    const centre = zones[1];
    const right = zones[zones.length - 1];

    // Scope controls share the left flank, group filter after the source.
    expect(left.textContent).toContain("直播源");
    expect(left.contains(screen.getByLabelText("频道分组"))).toBe(true);
    expect(left.contains(screen.getByLabelText("搜索直播频道"))).toBe(false);

    // The search owns the centre on its own and is the widened focal point.
    expect(centre.contains(screen.getByLabelText("搜索直播频道"))).toBe(true);
    expect(centre.contains(screen.getByLabelText("频道分组"))).toBe(false);
    expect(centre.className).toContain("shrink-0");
    expect(centre.className).toMatch(/lg:w-\[29rem\]/);

    // The flanks stay equal so the centre is genuinely centred.
    expect(left.className).toContain("flex-1");
    expect(right.className).toContain("flex-1");
  });

  it("substitutes the TVBox epg template before requesting the guide", async () => {
    // The TVBox `epg` field is a template. Requesting it verbatim made the provider answer
    // for the literal channel "{name}" and return a generic placeholder for every channel.
    useAppStore.setState({
      sources: [
        liveSource({ epg: "https://epg.example/?ch={name}&date={date}" }),
      ],
      liveFavorites: [],
      autoEpgEnabled: false,
    });

    render(<LiveView />);

    await waitFor(() => {
      expect(loadEpg).toHaveBeenCalled();
    });
    const request = loadEpg.mock.calls[0]?.[0] as { template: string };
    expect(request.template).toBe("https://epg.example/?ch={name}&date={date}");
    const channel = loadEpg.mock.calls[0]?.[1] as { name: string };
    expect(channel.name).toBe("City News");
  });

  it("uses the built-in guide when the source declares none", async () => {
    // The whole point of the automatic guide: the user should not have to hand-edit a TVBox
    // template to see what is on air.
    useAppStore.setState({
      sources: [liveSource({ epg: undefined })],
      liveFavorites: [],
      autoEpgEnabled: true,
    });

    render(<LiveView />);

    await waitFor(() => {
      expect(loadEpg).toHaveBeenCalled();
    });
    const request = loadEpg.mock.calls[0]?.[0] as { template: string; origin: string };
    expect(request.origin).toBe("auto");
    expect(request.template).toContain("epg.112114.xyz");
  });

  it("does not request a guide at all when auto guides are off and none is configured", async () => {
    useAppStore.setState({
      sources: [liveSource({ epg: undefined })],
      liveFavorites: [],
      autoEpgEnabled: false,
    });

    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });
    expect(loadEpg).not.toHaveBeenCalled();
    expect(
      screen.getByText("已关闭自动节目单，且该源未配置 EPG 地址"),
    ).toBeInTheDocument();
  });

  it("reports the programme airing now rather than the first of the day", async () => {
    // Providers return the whole day from 00:00, so programs[0] is the earliest programme.
    // Labelling it "当前" showed the 01:08 programme while 11:48 was on air.
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });
    expect(await screen.findByText(/当前：Morning News/)).toBeInTheDocument();
    expect(screen.getByText(/稍后：Evening Report/)).toBeInTheDocument();
  });

  it("says the channel is unlisted when the provider only returns placeholder filler", async () => {
    // 112114 answers HTTP 200 with a dozen identical "精彩节目" rows for any unknown name.
    // Rendering those would claim the guide works while every row said "exciting programming".
    loadEpg.mockResolvedValue({
      data: { programs: [] },
      mode: "unrecognized",
      origin: "auto",
      error: null,
    });
    useAppStore.setState({
      sources: [liveSource({ epg: undefined })],
      liveFavorites: [],
      autoEpgEnabled: true,
    });

    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });
    expect(
      await screen.findByText("节目单源未收录该频道"),
    ).toBeInTheDocument();
  });
});

describe("LiveView concurrent line probing", () => {
  afterEach(cleanup);

  beforeEach(() => {
    loadLiveCatalog.mockReset();
    loadEpg.mockReset();
    probeStreamUrls.mockReset();
    loadLiveCatalog.mockResolvedValue({ data: multiLineCatalog, error: null });
    loadEpg.mockResolvedValue({
      data: { programs: [] },
      mode: "empty",
      origin: "configured",
      error: null,
    });
    useAppStore.setState({
      sources: [liveSource()],
      liveFavorites: [],
      autoEpgEnabled: false,
    });
  });

  it("probes every line at once instead of waiting for each to fail in turn", async () => {
    // Lines used to be tried strictly in order: the player spent its whole timeout failing on
    // line 1 before line 2 was even attempted. All lines are now probed in one parallel pass.
    probeStreamUrls.mockResolvedValue([probe(0, false), probe(1, true), probe(2, false)]);
    render(<LiveView />);

    await waitFor(() => {
      expect(probeStreamUrls).toHaveBeenCalled();
    });
    // One call carrying every line is what makes the probing concurrent.
    expect(probeStreamUrls).toHaveBeenCalledWith([
      "https://stream.example/line-1.m3u8",
      "https://stream.example/line-2.m3u8",
      "https://stream.example/line-3.m3u8",
    ]);
  });

  it("switches to the fastest reachable line when the default one is dead", async () => {
    probeStreamUrls.mockResolvedValue([
      probe(0, false, 30),
      probe(1, true, 250),
      probe(2, true, 90),
    ]);
    render(<LiveView />);

    // Line 2 (index 2) is reachable and quicker than line 3, so it should be selected.
    await waitFor(() => {
      expect(screen.getByLabelText("线路 3（可用）")).toHaveClass("bg-primary");
    });
  });

  it("marks unreachable lines without hiding them", async () => {
    // A probe can be wrong about an operator-restricted address, so a dead line stays
    // clickable and merely dimmed rather than being removed.
    probeStreamUrls.mockResolvedValue([probe(0, true), probe(1, false), probe(2, false)]);
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByLabelText("线路 2（不可用）")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("线路 3（不可用）")).toBeEnabled();
  });

  it("explains an operator-restricted channel in the diagnosis instead of over the player", async () => {
    // China Mobile IPTV addresses only answer on China Mobile's own network; when every line
    // fails the cause is upstream, so the UI must say so rather than imply retrying helps.
    // It says it in 播放诊断: the player already reports that playback failed, and a second
    // banner on top of it only competed for attention.
    probeStreamUrls.mockResolvedValue([
      probe(0, false),
      probe(1, false),
      probe(2, false),
    ]);
    render(<LiveView />);

    // No banner is raised over the player, even once the probe knows every line is dead.
    await waitFor(() => {
      expect(probeStreamUrls).toHaveBeenCalled();
    });
    // The probe result has to be applied before the dialog is opened, since the note is derived
    // from it.
    await waitFor(() => {
      expect(screen.getByLabelText("线路 1（不可用）")).toBeInTheDocument();
    });
    expect(screen.queryByText("该频道所有线路均无法连接")).toBeNull();
    expect(screen.queryByText("播放受阻")).toBeNull();

    // The explanation is available where a user who wants it will look.
    fireEvent.click(screen.getByRole("button", { name: /播放诊断/ }));
    expect(await screen.findByText(/3 条线路/)).toBeInTheDocument();
    expect(screen.getByText(/运营商网络/)).toBeInTheDocument();
  });

  it("names the diagnosis control 播放诊断 and opens it as a dialog", async () => {
    // The button used to say 流诊断 while the player's own copy said 播放诊断, and it opened a
    // drawer instead of the dialog the movie library uses. One thing, one name, one presentation.
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });

    expect(screen.queryByText("流诊断")).toBeNull();
    expect(screen.queryByText("收起诊断")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /播放诊断/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("diagnostic-panel")).toBeInTheDocument();
  });

  it("does not put a second failure banner over the player", async () => {
    // The player already reports that playback failed and offers a retry. A banner on top of it
    // repeated the same message, and the specific cause is what 播放诊断 is for.
    probeStreamUrls.mockResolvedValue([probe(0, false), probe(1, false), probe(2, false)]);
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByLabelText("线路 1（不可用）")).toBeInTheDocument();
    });

    expect(screen.queryByText("播放受阻")).toBeNull();
    expect(screen.queryByText("该频道所有线路均无法连接")).toBeNull();
  });

  it("does not raise a banner for a guide failure while the channel still plays", async () => {
    // A missing programme guide does not stop playback, so a destructive banner over a working
    // player would report a problem the user does not have. The strip below the player says it.
    loadEpg.mockResolvedValue({
      data: { programs: [] },
      mode: "remote",
      origin: "auto",
      error: "EPG 响应请求失败：tcp connect error",
    });
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });
    await waitFor(() => {
      expect(loadEpg).toHaveBeenCalled();
    });

    expect(screen.queryByText("直播源请求失败")).toBeNull();
    expect(screen.queryByText(/tcp connect error/)).toBeNull();
    // The strip still reports the guide's state.
    expect(screen.getByText("节目单获取失败")).toBeInTheDocument();
  });

  it("still renders when line probing is unavailable", async () => {
    // `probeStreamUrls` returns null outside the desktop runtime, where the command is not
    // registered. The view called `.then` on that, which crashed the whole workspace — the
    // channel list and the player both vanished. Probing is an optimisation, so its absence has
    // to degrade to "no probe results" rather than take the page down.
    probeStreamUrls.mockResolvedValue(undefined);
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });
    // The workspace as a whole survived: the channel list and its controls are still there.
    expect(screen.getByLabelText("频道分组")).toBeInTheDocument();
  });

  it("still renders when line probing rejects", async () => {
    probeStreamUrls.mockRejectedValue(new Error("probe failed"));
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });
  });

  it("does not claim every line failed while one is still usable", async () => {
    probeStreamUrls.mockResolvedValue([probe(0, false), probe(1, true), probe(2, false)]);
    render(<LiveView />);

    await waitFor(() => {
      expect(probeStreamUrls).toHaveBeenCalled();
    });
    expect(
      screen.queryByText("该频道所有线路均无法连接"),
    ).not.toBeInTheDocument();
  });
});

describe("LiveView search scope", () => {
  afterEach(cleanup);

  beforeEach(() => {
    loadLiveCatalog.mockReset();
    loadEpg.mockReset();
    probeStreamUrls.mockReset();
    probeStreamUrls.mockResolvedValue(null);
    loadLiveCatalog.mockResolvedValue({ data: twoGroupCatalog, error: null });
    loadEpg.mockResolvedValue({
      data: { programs: [] },
      mode: "empty",
      origin: "configured",
      error: null,
    });
    useAppStore.setState({
      sources: [liveSource()],
      liveFavorites: [],
      autoEpgEnabled: false,
    });
  });

  function search(value: string) {
    fireEvent.change(screen.getByLabelText("搜索直播频道"), {
      target: { value },
    });
  }

  /** Picks a group from the dropdown. The default is now 全部分组, so tests select explicitly. */
  async function selectGroup(label: string) {
    const trigger = screen.getByLabelText("频道分组");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    const option = await screen.findByRole("option", { name: label });
    fireEvent.pointerUp(option);
    fireEvent.click(option);
  }

  /**
   * Channel names appear both in the list and in the player stub's title, so `getByText` is
   * ambiguous. Query inside the channel-list aside instead.
   */
  function channelListText() {
    const list = [...document.querySelectorAll("aside")].find((aside) =>
      aside.querySelector("[data-radix-scroll-area-viewport]"),
    );
    return list?.textContent ?? "";
  }

  it("finds a channel that lives in a different group than the selected one", async () => {
    // The search has always spanned every group; this locks that so a future change cannot
    // quietly narrow it to the selected group.
    render(<LiveView />);

    await waitFor(() => {
      expect(channelListText()).toContain("CCTV-1 综合");
    });
    // Narrow to 央视频道 explicitly, so the 湖南 channel is not listed yet.
    await selectGroup("央视频道");
    await waitFor(() => {
      expect(channelListText()).not.toContain("湖南卫视高清");
    });

    search("湖南");

    await waitFor(() => {
      expect(channelListText()).toContain("湖南卫视高清");
    });
    expect(channelListText()).not.toContain("CCTV-1 综合");
  });

  it("says the scope is all groups while a search is active", async () => {
    // The real defect the user saw: results spanned groups while the group control kept
    // saying "央视频道", which made the search look group-scoped.
    render(<LiveView />);

    await waitFor(() => {
      expect(channelListText()).toContain("CCTV-1 综合");
    });
    await selectGroup("央视频道");
    await waitFor(() => {
      expect(screen.getByLabelText("频道分组")).toHaveTextContent("央视频道");
    });

    search("卫视");

    await waitFor(() => {
      expect(screen.getByLabelText("频道分组")).toHaveTextContent(/全部分组/);
    });
    // And it names why: the search is overriding the group filter.
    expect(screen.getByLabelText("频道分组")).toHaveTextContent(/搜索中/);
  });

  it("restores the group filter when the search is cleared", async () => {
    render(<LiveView />);

    await waitFor(() => {
      expect(channelListText()).toContain("CCTV-1 综合");
    });
    await selectGroup("央视频道");
    await waitFor(() => {
      expect(screen.getByLabelText("频道分组")).toHaveTextContent("央视频道");
    });

    search("湖南");
    await waitFor(() => {
      expect(screen.getByLabelText("频道分组")).toHaveTextContent(/全部分组/);
    });

    fireEvent.click(screen.getByLabelText("清除搜索"));

    await waitFor(() => {
      expect(channelListText()).toContain("CCTV-1 综合");
    });
    expect(channelListText()).not.toContain("湖南卫视高清");
    expect(screen.getByLabelText("频道分组")).toHaveTextContent("央视频道");
  });

  it("shows the narrowed count so a filter never looks like it did nothing", async () => {
    render(<LiveView />);

    await waitFor(() => {
      expect(channelListText()).toContain("CCTV-1 综合");
    });
    // Every group is listed by default, so the count starts at the whole catalog.
    expect(screen.getByText("3 个频道")).toBeInTheDocument();

    // Group A holds two of the three channels, so selecting it narrows the count.
    await selectGroup("央视频道");
    expect(await screen.findByText("2 / 3 个频道")).toBeInTheDocument();

    search("湖南");

    expect(await screen.findByText("1 / 3 个频道")).toBeInTheDocument();
  });

  it("does not narrow the list to one group when stepping channels in 全部分组", async () => {
    // Stepping used to force `setGroupId(next.groupId)`, which would silently collapse an
    // all-groups browse back down to a single group.
    render(<LiveView />);

    await waitFor(() => {
      expect(channelListText()).toContain("CCTV-1 综合");
    });

    fireEvent.click(screen.getByLabelText("频道分组"));
    fireEvent.click(await screen.findByRole("option", { name: "全部分组" }));

    await waitFor(() => {
      expect(screen.getByText("3 个频道")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("下一个频道"));

    // The list must still span every group.
    expect(screen.getByText("3 个频道")).toBeInTheDocument();
    expect(screen.getByLabelText("频道分组")).toHaveTextContent("全部分组");
  });
});
