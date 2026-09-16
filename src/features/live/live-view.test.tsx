import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/features/player/media-diagnostic-panel", () => ({
  MediaDiagnosticPanel: () => <div data-testid="diagnostic-panel" />,
}));

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
    loadLiveCatalog.mockResolvedValue({
      data: { channels: [], groups: [] },
      error: "直播源请求失败",
    });

    render(<LiveView />);

    expect(await screen.findByText("直播数据请求失败")).toBeInTheDocument();
    expect(screen.getByText("直播源请求失败")).toBeInTheDocument();
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

  it("labels the group filter chips so a single unfamiliar group reads as a filter", async () => {
    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });

    const chip = screen.getByRole("button", { name: "News" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveAttribute("title", "只看「News」分组的频道");
    expect(screen.getByText("分组")).toBeInTheDocument();
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
