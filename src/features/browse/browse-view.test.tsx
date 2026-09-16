import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowseView } from "@/features/browse/browse-view";
import type { CatalogPage, SourceRecord, VodItem } from "@/types/moseek";

const searchVod = vi.fn();

// Only the adapter's network call is stubbed. The real module is spread back in so its other
// exports still resolve.
vi.mock("@/features/browse/cms-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/browse/cms-adapter")>();
  return {
    ...actual,
    searchVod: (...args: unknown[]) => searchVod(...args),
  };
});

const { useAppStore } = await import("@/stores/app-store");

function cmsSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
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
    // `isMovieLibrarySource` only lists sources whose test passed, so a fixture without this
    // is filtered out and the view renders its empty state.
    testStatus: "passed",
    lastCheckedAt: "now",
    requestCount: 0,
    ...overrides,
  } as SourceRecord;
}

function vodItem(overrides: Partial<VodItem> = {}): VodItem {
  return {
    id: "vod-1",
    sourceKey: "cms-main",
    sourceName: "主用影视源",
    name: "测试影片",
    poster: "",
    description: "",
    year: "2026",
    area: "",
    categories: [],
    actors: [],
    directors: [],
    playLines: [],
    ...overrides,
  };
}

function page(items: VodItem[]) {
  // searchVod resolves an AdapterResult, not a bare page; returning the page directly leaves
  // `result.data` undefined and the view renders its empty state.
  return {
    data: {
      sourceKey: "cms-main",
      items,
      categories: [],
      page: 1,
      pageCount: 1,
      pageSize: 12,
      total: items.length,
    } satisfies CatalogPage,
    mode: "remote" as const,
    error: null,
  };
}

describe("BrowseView catalog metadata", () => {
  afterEach(cleanup);

  beforeEach(() => {
    searchVod.mockReset();
    useAppStore.setState({
      sources: [cmsSource()],
      favorites: [],
    });
  });

  it("does not render a placeholder area when the source reports none", async () => {
    // The list API returns no `vod_area` for most sources, and a literal "未知地区" read as a
    // broken field rather than as missing metadata. Only known values should be shown.
    searchVod.mockResolvedValue(page([vodItem({ area: "" })]));
    render(<BrowseView onNavigate={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("测试影片")).toBeInTheDocument();
    });
    expect(screen.queryByText(/未知地区/)).not.toBeInTheDocument();
    // The source name is still worth showing on its own. Scope to the card's metadata line,
    // because the source also appears in the header's source selector.
    const metadata = screen
      .getAllByText(/主用影视源/)
      .find((node) => node.tagName === "P");
    expect(metadata).toHaveTextContent("主用影视源");
    expect(metadata).not.toHaveTextContent("·");
  });

  it("shows the area when the source does report one", async () => {
    searchVod.mockResolvedValue(page([vodItem({ area: "中国大陆" })]));
    render(<BrowseView onNavigate={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("测试影片")).toBeInTheDocument();
    });
    expect(screen.getByText("中国大陆 · 主用影视源")).toBeInTheDocument();
  });

  it("renders the poster the catalog provides", async () => {
    searchVod.mockResolvedValue(
      page([vodItem({ poster: "https://img.example/poster.jpg" })]),
    );
    render(<BrowseView onNavigate={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("测试影片")).toBeInTheDocument();
    });
    const img = document.querySelector("img");
    expect(img).toHaveAttribute("src", "https://img.example/poster.jpg");
  });

  it("labels the quick-play button 立即播放", async () => {
    // It read "立即起播", which is not how anyone says it.
    searchVod.mockResolvedValue(
      page([
        vodItem({
          playLines: [
            {
              id: "line-1",
              name: "dyttm3u8",
              episodes: [{ id: "ep-1", name: "第01集", url: "https://cdn/1.m3u8" }],
            },
          ],
        }),
      ]),
    );
    render(<BrowseView onNavigate={() => {}} />);

    const card = await screen.findByText("测试影片");
    card.click();

    const play = await screen.findByRole("button", { name: /立即播放：第01集/ });
    expect(play).toBeInTheDocument();
    expect(screen.queryByText(/立即起播/)).not.toBeInTheDocument();
  });
});
