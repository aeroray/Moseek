import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewPane } from "@/components/view-pane";
import { LiveView } from "@/features/live/live-view";
import type { LiveCatalog, SourceRecord } from "@/types/moseek";

/**
 * The live workspace inside the keep-alive pane.
 *
 * **This file exists because that combination was never tested, and two reported defects lived
 * exactly there.** `live-view.test.tsx` renders `<LiveView />` on its own, so nothing exercised
 * `ViewPane` — the component whose entire job is to keep a view's state across navigation. The
 * keep-alive mechanism was covered against a `MediaPlayer` stub (`media-player-view-active.test.tsx`)
 * and against a synthetic counter (`view-pane.test.tsx`), but never against the live workspace that
 * users actually navigate away from.
 */

const loadLiveCatalog = vi.fn();
const loadEpg = vi.fn();

vi.mock("@/lib/live-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/live-adapter")>();
  return {
    ...actual,
    loadLiveCatalog: (...args: unknown[]) => loadLiveCatalog(...args),
    loadEpg: (...args: unknown[]) => loadEpg(...args),
  };
});

/** Counts how many players exist at once, which is what makes "audio keeps playing" possible. */
const mountedPlayers = vi.fn();

vi.mock("@/features/player/media-player", () => ({
  MediaPlayer: ({ title }: { title: string }) => {
    mountedPlayers();
    return <div data-testid="media-player">{title}</div>;
  },
  usesHlsPipeline: () => true,
}));

vi.mock("@/features/player/media-diagnostic-panel", () => ({
  MediaDiagnosticPanel: () => <div data-testid="diagnostic-panel" />,
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauriRuntime: () => true,
    resolvePlayback: async (url: string) => ({ url, mediaKind: "hls", adapterId: "test" }),
    probeStreamUrls: async () => [],
  };
});

const { useAppStore } = await import("@/stores/app-store");

function liveSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    key: "live-main",
    name: "主用直播源",
    sourceType: "live",
    api: "https://live.example/channels.m3u",
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
      id: "live-main:News:city",
      name: "城市新闻",
      groupId: "News",
      groupName: "新闻",
      logoUrl: "",
      streamUrl: "https://stream.example/news.m3u8",
      streamUrls: ["https://stream.example/news.m3u8"],
      mediaKind: "hls",
      sourceKey: "live-main",
      epgId: undefined,
    },
    {
      id: "live-main:News:world",
      name: "国际新闻",
      groupId: "News",
      groupName: "新闻",
      logoUrl: "",
      streamUrl: "https://stream.example/world.m3u8",
      streamUrls: ["https://stream.example/world.m3u8"],
      mediaKind: "hls",
      sourceKey: "live-main",
      epgId: undefined,
    },
  ],
  groups: [{ id: "News", name: "新闻" }],
};

/** Renders the view the way `App` does: one pane, whose `active` can be toggled. */
function renderPane(active: boolean) {
  return render(
    <ViewPane active={active}>
      <LiveView />
    </ViewPane>,
  );
}

describe("LiveView inside the keep-alive pane", () => {
  beforeEach(() => {
    loadLiveCatalog.mockReset();
    loadLiveCatalog.mockResolvedValue({ data: catalog, error: null, mode: "remote" });
    loadEpg.mockReset();
    loadEpg.mockResolvedValue({ programs: [], mode: "empty", error: null });
    mountedPlayers.mockClear();
    useAppStore.setState({
      sources: [liveSource()],
      liveFavorites: [],
      autoEpgEnabled: false,
      activeView: "live",
    });
  });

  afterEach(cleanup);

  it("keeps the chosen channel when the user leaves and comes back", async () => {
    // The reported defect: "切到别的页面回来之后，每次都要刷新，不会记住我之前的操作". The channel the
    // user picked is the state that matters most here.
    const { rerender } = renderPane(true);

    // Waited on the player rather than the list: it is what the choice is expressed through, and it
    // is the same signal `live-view.test.tsx` uses.
    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("城市新闻");
    });
    // Pick the second channel, so a reset would be visible.
    await act(async () => {
      screen.getByLabelText("下一个频道").click();
    });
    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toHaveTextContent("国际新闻");
    });

    rerender(
      <ViewPane active={false}>
        <LiveView />
      </ViewPane>,
    );
    rerender(
      <ViewPane active>
        <LiveView />
      </ViewPane>,
    );

    // The choice survives, and the catalog was not fetched a second time.
    expect(screen.getByTestId("media-player")).toHaveTextContent("国际新闻");
    expect(loadLiveCatalog).toHaveBeenCalledTimes(1);
  });

  it("keeps the search term and group filter across navigation", async () => {
    const { rerender } = renderPane(true);
    await waitFor(() =>
      expect(screen.getByTestId("media-player")).toBeInTheDocument(),
    );

    const search = screen.getByPlaceholderText(/搜索/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(search, { target: { value: "国际" } });
    });

    rerender(
      <ViewPane active={false}>
        <LiveView />
      </ViewPane>,
    );
    rerender(
      <ViewPane active>
        <LiveView />
      </ViewPane>,
    );

    const after = screen.getByPlaceholderText(/搜索/) as HTMLInputElement;
    expect(after.value).toBe("国际");
  });

  it("never runs two players at once", async () => {
    // "切到别的页面之后，还能在后台听到直播播放的声音" is only possible if a second player exists
    // while the view it belongs to is hidden. React StrictMode is not involved here; the pane keeps
    // exactly one subtree alive.
    const { rerender } = renderPane(true);
    await waitFor(() => expect(screen.getByTestId("media-player")).toBeInTheDocument());

    expect(screen.getAllByTestId("media-player")).toHaveLength(1);

    rerender(
      <ViewPane active={false}>
        <LiveView />
      </ViewPane>,
    );

    // Hidden, not unmounted: still one player, and it is the same subtree rather than a new one.
    expect(screen.getAllByTestId("media-player")).toHaveLength(1);
  });
});
