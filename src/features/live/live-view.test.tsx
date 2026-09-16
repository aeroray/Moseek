import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveView } from "@/features/live/live-view";
import type { EpgCatalog, LiveCatalog, SourceRecord } from "@/types/moseek";

const loadLiveCatalog = vi.fn();
const loadEpg = vi.fn();

// `resolveEpgUrl` is pure, so the real implementation is reused rather than stubbed: the
// view depends on its template substitution when deciding which EPG URL to request.
vi.mock("@/lib/live-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/live-adapter")>();
  return {
    resolveEpgUrl: actual.resolveEpgUrl,
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
    loadEpg.mockResolvedValue({
      data: {
        programs: [
          {
            id: "news.one-0",
            channelId: "news.one",
            title: "Morning News",
            description: "",
            startAt: "07:30",
            endAt: "09:00",
          },
        ],
      } satisfies EpgCatalog,
      error: null,
    });
    useAppStore.setState({
      sources: [liveSource()],
      liveFavorites: [],
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
    loadLiveCatalog.mockResolvedValue({ data: catalog, error: null });
    useAppStore.setState({
      sources: [
        liveSource({ epg: "https://epg.example/?ch={name}&date={date}" }),
      ],
      liveFavorites: [],
    });

    render(<LiveView />);

    await waitFor(() => {
      expect(loadEpg).toHaveBeenCalled();
    });
    const requestedUrl = loadEpg.mock.calls[0]?.[0] as string;
    expect(requestedUrl).toContain("ch=news.one");
    expect(requestedUrl).not.toContain("{name}");
    expect(requestedUrl).not.toContain("{date}");
  });

  it("explains that EPG is unconfigured rather than claiming there is no data", async () => {
    // "暂无实时节目单信息" was shown both when the source had no EPG at all and when a
    // configured guide returned nothing, which made a configuration gap look like a bug.
    useAppStore.setState({
      sources: [liveSource({ epg: undefined })],
      liveFavorites: [],
    });

    render(<LiveView />);

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("City News");
    });
    expect(
      screen.getByText("当前直播源未配置 EPG 节目单地址"),
    ).toBeInTheDocument();
    expect(loadEpg).not.toHaveBeenCalled();
  });
});
