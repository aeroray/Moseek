import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowseView } from "@/features/browse/browse-view";
import type { CatalogPage, SourceRecord, VodItem } from "@/types/moseek";

const searchVod = vi.fn();
const getDetail = vi.fn();

// Only the adapter's network call is stubbed. The real module is spread back in so its other
// exports still resolve.
vi.mock("@/features/browse/cms-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/browse/cms-adapter")>();
  return {
    ...actual,
    searchVod: (...args: unknown[]) => searchVod(...args),
  };
});

// The lowest choke point for a per-work fetch. The library must not reach it: that is the rule this
// suite pins (see "shows a coverless listing exactly as the source gave it").
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    getDetail: (...args: unknown[]) => getDetail(...args),
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

function page(items: VodItem[], overrides: Partial<CatalogPage> = {}) {
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
      ...overrides,
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

  it("favourites a work from the card without opening it", async () => {
    // The point of the button: favouriting must not cost a navigation. It also has to work
    // without a hover, which is why it is not revealed on hover like the poster action.
    searchVod.mockResolvedValue(page([vodItem()]));
    render(<BrowseView onNavigate={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("测试影片")).toBeInTheDocument();
    });

    const button = screen.getByRole("button", { name: "收藏 测试影片" });
    fireEvent.click(button);

    expect(
      useAppStore.getState().favorites.some((f) => f.item.id === "vod-1"),
    ).toBe(true);
    // The label flips, so the control reports its own state.
    expect(
      screen.getByRole("button", { name: "取消收藏 测试影片" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("does not open the work when the favourite button is used", async () => {
    // The card itself means "play this", so the nested button must not also trigger it.
    searchVod.mockResolvedValue(page([vodItem()]));
    render(<BrowseView onNavigate={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("测试影片")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "收藏 测试影片" }));

    // Opening the work would have mounted the player view.
    expect(screen.queryByText("正在准备播放…")).toBeNull();
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

describe("BrowseView loading states", () => {
  afterEach(cleanup);

  beforeEach(() => {
    searchVod.mockReset();
    getDetail.mockReset();
    useAppStore.setState({
      sources: [cmsSource()],
      favorites: [],
    });
  });

  it("shows a coverless listing exactly as the source gave it", async () => {
    // The library makes one request and renders its answer. It does **not** go and fetch a detail
    // record per work to fill in covers: that fan-out was measured (20 requests, 6 762 ms against
    // one page-wide request at 26 207 ms) and rejected by the user, because twenty requests against
    // one host invites rate limiting and a library must not be nondeterministic. The card shows its
    // own "暂无海报" state, which is the honest rendering of what the source published — and no
    // per-work request is made at all.
    searchVod.mockResolvedValue(page([vodItem({ name: "无封面影片" })]));

    render(<BrowseView onNavigate={() => {}} />);

    expect(await screen.findByText("无封面影片")).toBeInTheDocument();
    // Scoped to the poster: the "no poster" placeholder draws the app mark, which is also an img.
    expect(document.querySelector('img[alt="无封面影片 海报"]')).toBeNull();
    expect(
      screen.getByRole("img", { name: "无封面影片 海报，暂无可用图片" }),
    ).toBeInTheDocument();

    // Give anything asynchronous a chance to land, then confirm the library never went looking.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getDetail).not.toHaveBeenCalled();
    expect(document.querySelector('img[alt="无封面影片 海报"]')).toBeNull();
  });

  it("renders the cover the listing itself provided", async () => {
    // The other half of the same rule: a source that *does* publish covers in its listing keeps them.
    searchVod.mockResolvedValue(
      page([vodItem({ name: "有封面影片", poster: "https://img.example/a.jpg" })]),
    );

    render(<BrowseView onNavigate={() => {}} />);

    expect(await screen.findByText("有封面影片")).toBeInTheDocument();
    expect(
      document.querySelector('img[alt="有封面影片 海报"]'),
    ).toHaveAttribute("src", "https://img.example/a.jpg");
  });

  it("does not claim a page count before the current scope has been read", async () => {
    // The reported confusion: "the pagination and the total are already there but the page never
    // stops loading". The footer rendered `catalog?.pageCount ?? 1`, so it announced "第 1 / 1 页"
    // — a definite answer about a result set nothing had read yet — under a skeleton. A number
    // that is not known has to look like one that is not known.
    searchVod.mockReturnValue(new Promise(() => {}));

    render(<BrowseView onNavigate={() => {}} />);

    expect(screen.getByText(/第 1 \/ … 页/)).toBeInTheDocument();
    expect(screen.queryByText(/第 1 \/ 1 页/)).toBeNull();
    // Nor may the total claim to be known.
    expect(screen.getByText("读取中")).toBeInTheDocument();
  });
});
