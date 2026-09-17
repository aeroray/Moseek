import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    // Listing in the movie library depends on `enabled`, not on the test status: a source the
    // user has switched on is selectable whether or not they have audited it.
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

  it("groups the source and category on the left and centres a widened search", async () => {
    // The source and the category are both scope controls — what is being browsed — so they sit
    // together on the left. The search is the term and owns the centre, widened to hold the
    // width the category gave up.
    searchVod.mockResolvedValue(page([vodItem()]));
    render(<BrowseView onNavigate={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("测试影片")).toBeInTheDocument();
    });

    const header = document.querySelector("header");
    const zones = [...(header?.children ?? [])] as HTMLElement[];
    // left scope group, centred search, right controls
    const left = zones[0];
    const centre = zones[1];
    const right = zones[zones.length - 1];

    // Scope controls share the left flank, in order.
    expect(left.textContent).toContain("影视源");
    expect(left.contains(screen.getByLabelText("影片分类"))).toBe(true);
    expect(left.contains(screen.getByPlaceholderText(/搜索影片/))).toBe(false);

    // The search owns the centre on its own, and is wide enough to be the focal point.
    expect(centre.contains(screen.getByPlaceholderText(/搜索影片/))).toBe(true);
    expect(centre.contains(screen.getByLabelText("影片分类"))).toBe(false);
    expect(centre.className).toContain("shrink-0");
    expect(centre.className).toMatch(/lg:w-\[29rem\]/);

    // The flanks stay equal so the centre is genuinely centred.
    expect(left.className).toContain("flex-1");
    expect(right.className).toContain("flex-1");
  });

  it("opens the watch page directly from a catalog card", async () => {
    // Detail and playback used to be two pages, so watching anything took two clicks and the
    // second page lost the metadata. Clicking a card now lands on one page that is already
    // playing the first episode, with the rail beside it.
    searchVod.mockResolvedValue(
      page([
        vodItem({
          playLines: [
            {
              id: "line-1",
              name: "dyttm3u8",
              episodes: [
                { id: "ep-1", name: "第01集", url: "https://cdn/1.m3u8" },
                { id: "ep-2", name: "第02集", url: "https://cdn/2.m3u8" },
              ],
            },
          ],
        }),
      ]),
    );
    render(<BrowseView onNavigate={() => {}} />);

    const card = await screen.findByText("测试影片");
    card.click();

    // One click reaches playback: the rail is present and the first episode is already active.
    expect(await screen.findByText("线路与选集")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "第02集" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "第01集" }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("resets the category when the source changes", async () => {
    // Category ids only mean something inside the source that issued them. Carrying one across
    // a source switch left the request filtering on a category the new source may not have,
    // which returned an empty catalog for a choice the user never made on that source.
    const twoSources = [
      cmsSource({ key: "cms-main", name: "主用影视源" }),
      cmsSource({ key: "cms-backup", name: "备用影视源" }),
    ];
    useAppStore.setState({ sources: twoSources, favorites: [] });
    searchVod.mockResolvedValue({
      ...page([vodItem()]),
      data: {
        ...page([vodItem()]).data,
        categories: [{ id: "cat-2", name: "电视剧" }],
      },
    });
    render(<BrowseView onNavigate={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("测试影片")).toBeInTheDocument();
    });

    // Pick a category on the first source.
    fireEvent.click(screen.getByLabelText("影片分类"));
    fireEvent.click(await screen.findByRole("option", { name: "电视剧" }));
    await waitFor(() => {
      expect(searchVod).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        "cat-2",
        expect.anything(),
        expect.anything(),
      );
    });

    // Switch source; the category must go back to 全部分类 rather than leak across.
    fireEvent.click(screen.getByLabelText("影视源"));
    fireEvent.click(await screen.findByRole("option", { name: "备用影视源" }));

    await waitFor(() => {
      expect(searchVod).toHaveBeenLastCalledWith(
        expect.objectContaining({ key: "cms-backup" }),
        expect.anything(),
        "all",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it("filters the catalog by a category chosen from the dropdown", async () => {
    // The categories used to be a row of chips capped at the first eight, which hid the rest of
    // the list and crowded the toolbar. The dropdown replaced them and must still filter.
    searchVod.mockResolvedValue({
      ...page([vodItem()]),
      data: {
        ...page([vodItem()]).data,
        categories: [
          { id: "cat-1", name: "电影" },
          { id: "cat-2", name: "电视剧" },
        ],
      },
    });
    render(<BrowseView onNavigate={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("测试影片")).toBeInTheDocument();
    });

    // The old chip row is gone.
    expect(screen.queryByRole("button", { name: "全部" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("影片分类"));
    fireEvent.click(await screen.findByRole("option", { name: "电视剧" }));

    await waitFor(() => {
      expect(searchVod).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "cat-2",
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
