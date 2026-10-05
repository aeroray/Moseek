import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewPane, useViewActive } from "@/components/view-pane";
import { FavoritesView } from "@/features/browse/favorites-view";
import type { LiveFavorite, VodFavorite } from "@/types/moseek";

/**
 * A player opened from 我的收藏 must stop when the user leaves the page.
 *
 * **This is the reported defect: "从收藏页面点击播放内容后，切到别的页面，收藏页面的内容还在后台进行播放，
 * 并且还在播放声音".** The live workspace was fixed for the same thing, and its own tests
 * (`media-player-live-view-away.test.tsx`) cover a player inside a `ViewPane`. What was never covered
 * is the path a user actually takes: opening a favourite, which renders a *different* component
 * (`FavoriteWatchView` / `FavoriteLiveView`) in place of the columns, still inside the same pane.
 *
 * The player is stubbed, but the stub keeps the two things that decide the outcome: it reads
 * `useViewActive()` from the real context, and it reports what it was told — so the assertion is about
 * the context reaching the player through the favourites page, not about Plyr.
 */

const mounted = vi.fn();
const viewActiveSeen: boolean[] = [];

vi.mock("@/features/player/media-player", () => ({
  MediaPlayer: ({ title }: { title: string }) => {
    // The real hook, against the real provider — this is what the assertion is about.
    const active = useViewActive();
    mounted();
    viewActiveSeen.push(active);
    return (
      <div data-testid="media-player" data-view-active={String(active)}>
        {title}
      </div>
    );
  },
  usesHlsPipeline: () => true,
}));

vi.mock("@/features/player/use-stream-probes", () => ({
  useStreamProbes: (urls: string[]) => ({
    probes: [],
    isProbing: false,
    streamIndex: 0,
    selectStream: vi.fn(),
    probeFor: () => urls[0],
  }),
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
    getDetail: async () => null,
    searchVod: async () => ({ data: { items: [], categories: [], page: 1, pageCount: 1 }, mode: "remote", error: null }),
  };
});

const { useAppStore } = await import("@/stores/app-store");

function vodFavorite(): VodFavorite {
  return {
    key: "demo:vod-1",
    item: {
      id: "vod-1",
      name: "收藏剧集",
      // `playLines` is the field the resolver reads (`pickEntryEpisode`), and the whole point of a
      // favourite is that it carries them.
      playLines: [
        {
          id: "line-1",
          name: "线路一",
          episodes: [
            { id: "ep-1", name: "第 1 集", url: "https://stream.example/ep1.m3u8" },
          ],
        },
      ],
    } as unknown as VodFavorite["item"],
    sourceKey: "demo",
    sourceName: "示例源",
    savedAt: "2026-01-01T00:00:00.000Z",
    progress: null,
  };
}

function liveFavorite(): LiveFavorite {
  return {
    key: "demo:ch-1",
    channel: {
      id: "demo:ch-1",
      name: "收藏频道",
      groupId: "g",
      groupName: "央视",
      logoUrl: "",
      streamUrl: "https://stream.example/live.m3u8",
      streamUrls: ["https://stream.example/live.m3u8"],
      mediaKind: "hls",
      sourceKey: "demo",
    },
    sourceKey: "demo",
    sourceName: "示例源",
    savedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderPane(active: boolean) {
  return render(
    <ViewPane active={active}>
      <FavoritesView onNavigate={() => {}} />
    </ViewPane>,
  );
}

describe("a player opened from 我的收藏", () => {
  beforeEach(() => {
    mounted.mockClear();
    viewActiveSeen.length = 0;
    useAppStore.setState({
      favorites: [vodFavorite()],
      liveFavorites: [liveFavorite()],
      activeView: "favorites",
    });
  });

  afterEach(cleanup);

  it("sees the pane's active state while the user is on the page", async () => {
    renderPane(true);
    fireEvent.click(screen.getByText("收藏剧集"));

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toBeInTheDocument();
    });
    expect(screen.getByTestId("media-player")).toHaveAttribute(
      "data-view-active",
      "true",
    );
  });

  it("is told the view went away when the user navigates off 我的收藏", async () => {
    // **The defect.** The player is rendered by a different component once a favourite is opened, and
    // that component must still sit under the pane's context. If it does not — a portal, a separate
    // tree, a provider that stops at the columns — the player never learns the view is gone, keeps
    // playing, and keeps its audio.
    const { rerender } = renderPane(true);
    fireEvent.click(screen.getByText("收藏剧集"));
    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toBeInTheDocument();
    });

    rerender(
      <ViewPane active={false}>
        <FavoritesView onNavigate={() => {}} />
      </ViewPane>,
    );

    // The player is still mounted — the pane keeps it alive on purpose — but it must know it is off
    // screen, which is what makes it pause.
    const player = screen.getByTestId("media-player");
    expect(player).toBeInTheDocument();
    expect(player).toHaveAttribute("data-view-active", "false");
  });

  it("is told the view went away for a live favourite too", async () => {
    // The live half renders a different component again (`FavoriteLiveView`), so it needs its own
    // assertion: the two detail views are separate code paths and only one of them being wired is
    // exactly the kind of half-fix that survives a single test.
    const { rerender } = renderPane(true);
    fireEvent.click(screen.getByText("收藏频道"));

    await waitFor(() => {
      expect(screen.getByTestId("media-player")).toBeInTheDocument();
    });

    rerender(
      <ViewPane active={false}>
        <FavoritesView onNavigate={() => {}} />
      </ViewPane>,
    );

    expect(screen.getByTestId("media-player")).toHaveAttribute(
      "data-view-active",
      "false",
    );
  });
});
