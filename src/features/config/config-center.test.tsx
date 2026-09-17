import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastHost } from "@/components/toast-host";
import { ToastProvider } from "@/components/ui/toast";
import { ConfigCenter } from "@/features/config/config-center";
import { testSource as testSourceCommand } from "@/lib/tauri";
import { useAppStore } from "@/stores/app-store";
import type { SourceRecord, SourceTestResult } from "@/types/moseek";

// The page's job is to answer three questions in order: which configuration am I on, what is in
// it, and which of its sources actually work. These tests pin that shape, and the vocabulary a
// user meets while reading it.
vi.mock("@/lib/tauri", () => ({
  isTauriRuntime: () => true,
  listScriptArchives: vi.fn(async () => []),
  loadActiveConfig: vi.fn(async () => null),
  listConfigDocuments: vi.fn(async () => []),
  recoverKnownLiveSources: vi.fn(async () => null),
  exportConfig: vi.fn(),
  testSource: vi.fn(),
  updateSourceTest: vi.fn(),
  activateConfigDocument: vi.fn(),
  deleteConfigDocument: vi.fn(),
  saveConfigDocument: vi.fn(),
  setConfigSourceBaseUrl: vi.fn(),
  setSourceScriptArchive: vi.fn(),
  findConfigDuplicate: vi.fn(async () => null),
  fetchConfigUrl: vi.fn(),
}));

function testResult(
  overrides: Partial<SourceTestResult> = {},
): SourceTestResult {
  return {
    sourceKey: "ok",
    status: "passed",
    adapterId: "builtin-cms",
    message: "请求成功。",
    itemCount: 12,
    categoryCount: 3,
    durationMs: 40,
    testedAt: "刚刚",
    operations: [],
    ...overrides,
  } as SourceTestResult;
}

function source(overrides: Partial<SourceRecord>): SourceRecord {
  return {
    key: "demo",
    name: "示例源",
    sourceType: "cms",
    api: "https://example.com/api.php/provide/vod/",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "普通 HTTP API。",
    testStatus: "untested",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
    ...overrides,
  };
}

const supported = source({ key: "ok", name: "可用的源" });
const blocked = source({
  key: "no",
  name: "不可用的源",
  capability: "blocked",
  capabilityNote: "检测到远程脚本，默认阻止。",
  enabled: false,
  api: "csp_XBPQ",
  siteProtocol: "xbpq",
});
const needsAdapter = source({
  key: "wait",
  name: "待适配的源",
  capability: "needs-adapter",
  capabilityNote: "需要单独适配器。",
  enabled: false,
  api: "proxy://demo",
});

/**
 * Renders the page inside the toast host it depends on. The page reports the outcome of a test
 * run through a toast, so without the host every render would throw.
 */
function renderPage(ui: React.ReactElement) {
  return render(
    <ToastProvider>
      <ToastHost>{ui}</ToastHost>
    </ToastProvider>,
  );
}

function renderCenter() {
  const configText = JSON.stringify({
    sites: [
      { key: "ok", name: "可用的源", api: supported.api },
      { key: "no", name: "不可用的源", api: blocked.api },
    ],
  });
  useAppStore.setState({
    sources: [supported, blocked, needsAdapter],
    rawConfig: configText,
    normalizedConfig: configText,
    configDocuments: [
      { id: 1, name: "主配置", sourceCount: 3, liveCount: 0, importedAt: "2026-01-01T00:00:00.000Z" },
    ],
    configDocumentCache: {},
    activeConfigId: 1,
    lastImportedAt: "2026-01-01T00:00:00.000Z",
  });
  return renderPage(<ConfigCenter />);
}

/** Radix Select renders its list in a portal and needs a pointer sequence to open. */
function chooseFilter(label: string) {
  const trigger = screen.getByLabelText("筛选状态");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  const option = screen.getByRole("option", { name: label });
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}

describe("config center", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("names itself 配置中心", () => {
    // "配置与源" described the page's contents rather than its role; 配置中心 says what it is.
    renderCenter();

    expect(
      screen.getByRole("heading", { name: "配置中心" }),
    ).toBeInTheDocument();
  });

  it("keeps the archive to a single switcher row", () => {
    // The archive used to be a five-column table with per-row buttons, which is more ceremony
    // than picking a configuration deserves.
    renderCenter();

    expect(screen.getByLabelText("切换配置")).toBeInTheDocument();
    expect(screen.queryByText("配置档案库")).not.toBeInTheDocument();
    expect(screen.queryByText("导入时间")).not.toBeInTheDocument();
    expect(screen.queryByText("当前使用")).not.toBeInTheDocument();
  });

  it("does not restate the source counts as a row of cards", () => {
    // Five cards repeated what the list below already shows per row, and none of them could be
    // acted on. "已识别源" existed only in that row, so it is the reliable marker. (The status
    // words themselves still appear as per-row badges, which is where they belong.)
    renderCenter();

    expect(screen.queryByLabelText("配置解析报告")).not.toBeInTheDocument();
    expect(screen.queryByText("已识别源")).not.toBeInTheDocument();
    expect(screen.queryByText("普通可用")).not.toBeInTheDocument();
  });

  it("calls the list a source list and its column a resource name", () => {
    // "资源源" was a typo-like duplication, and "能力" named the mechanism rather than the
    // outcome a user cares about.
    renderCenter();

    expect(screen.getByRole("tab", { name: /源清单/ })).toBeInTheDocument();
    expect(screen.getByText("资源名称")).toBeInTheDocument();
    expect(screen.queryByText("资源源")).not.toBeInTheDocument();
    expect(screen.queryByText("能力")).not.toBeInTheDocument();
  });

  it("opens on the usable sources rather than the whole configuration", () => {
    // A configuration carries far more unusable sources than usable ones, so 全部 opened the page
    // on a wall of rows the user cannot act on.
    renderCenter();

    expect(screen.getByText("可用的源")).toBeInTheDocument();
    expect(screen.queryByText("不可用的源")).not.toBeInTheDocument();
    expect(screen.queryByText("待适配的源")).not.toBeInTheDocument();
  });

  it("groups the filter into usable and unusable rather than five parser states", () => {
    // 部分可用 / 待适配 / 配置无效 all mean "not usable right now"; asking a user to choose
    // between them is asking them to learn the parser's taxonomy.
    renderCenter();

    const trigger = screen.getByLabelText("筛选状态");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    expect(screen.getByRole("option", { name: "已适配" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "未适配" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "全部" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "部分可用" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "待适配" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "配置无效" })).not.toBeInTheDocument();
  });

  it("filters to the unusable sources when asked", () => {
    renderCenter();

    chooseFilter("未适配");

    expect(screen.getByText("不可用的源")).toBeInTheDocument();
    expect(screen.getByText("待适配的源")).toBeInTheDocument();
    expect(screen.queryByText("可用的源")).not.toBeInTheDocument();
  });

  it("leads the adapter cell with an icon saying whether an adapter exists", () => {
    // The words 可执行 / 未适配 wrapped onto a second line and read as a status report. An icon
    // badge in front answers "is this handled at all?" first, which is the question that matters
    // before the adapter's name.
    renderCenter();
    chooseFilter("未适配");

    const blockedRow = screen
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("不可用的源"));
    expect(blockedRow).toBeTruthy();
    expect(
      within(blockedRow as HTMLElement).getByText("没有可用适配器"),
    ).toBeInTheDocument();
    // The old wording is gone, so nothing wraps onto a second line.
    expect(
      within(blockedRow as HTMLElement).queryByText("未适配"),
    ).not.toBeInTheDocument();

    chooseFilter("已适配");
    const okRow = screen
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("可用的源"));
    expect(
      within(okRow as HTMLElement).getByText("已有适配器"),
    ).toBeInTheDocument();
    expect(
      within(okRow as HTMLElement).queryByText("可执行"),
    ).not.toBeInTheDocument();
  });

  it("keeps the table header in place while the list scrolls", () => {
    // jsdom cannot scroll, so the class contract that makes the header stick is what is pinned.
    // It only works because the table wrapper is not itself a scroll container: a sticky header
    // inside one sticks to that box instead of the outer region and never appears to stick.
    renderCenter();

    const header = document.querySelector("[data-slot='table-header']");
    expect(header?.className).toContain("sticky");
    expect(header?.className).toContain("top-0");
    expect(
      document.querySelector("[data-slot='table-container']")?.className,
    ).toContain("overflow-visible");
  });

  it("lines the enable and action columns up with their headers", () => {
    // The header was centred while the cells were right-aligned, so the switch and the buttons
    // sat in a different place from the labels above them.
    renderCenter();

    const heads = [...document.querySelectorAll("thead th")];
    const enableHead = heads.find((h) => h.textContent?.trim() === "启用");
    const actionHead = heads.find((h) => h.textContent?.trim() === "操作");
    expect(enableHead?.className).toContain("text-center");
    expect(actionHead?.className).toContain("text-center");

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("可用的源"));
    const cells = [...(row as HTMLElement).querySelectorAll("td")];
    // The enable cell and the action cell both centre their contents.
    expect(cells[cells.length - 2].className).toContain("text-center");
    expect(
      cells[cells.length - 1].querySelector("div")?.className,
    ).toContain("justify-center");
  });

  it("puts the adapter badge before the adapter name", () => {
    // The badge answers "is this handled at all?", which is the question to settle before
    // reading which adapter handles it.
    renderCenter();

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("可用的源"));
    const cell = (row as HTMLElement).querySelectorAll("td")[2];
    const badge = cell.querySelector("[data-slot='badge']");
    const name = cell.querySelector("span.truncate");
    expect(badge).toBeTruthy();
    expect(name).toBeTruthy();
    expect(
      badge!.compareDocumentPosition(name!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not offer an enable switch for a source that cannot run", () => {
    // The switch moved and did nothing, which reads as the app ignoring the click. A dash is the
    // honest answer for "not applicable".
    renderCenter();

    expect(screen.getByRole("switch", { name: "启用 可用的源" })).toBeInTheDocument();

    chooseFilter("未适配");
    expect(
      screen.queryByRole("switch", { name: "启用 不可用的源" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "启用 待适配的源" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer a connection test for a source that cannot run", () => {
    // A test for a source with no working adapter can only fail, which tells the user nothing.
    renderCenter();
    chooseFilter("全部");

    expect(screen.getAllByRole("button", { name: /^测试 / })).toHaveLength(1);
  });

  it("opens the detail sheet by clicking the row, with no extra button", () => {
    // The row already opens the sheet, so a "详情" control repeated what a click anywhere did.
    // Checked on both branches: the testable rows render a test button and the others render
    // nothing, so a stray control could hide in whichever branch the default filter shows.
    renderCenter();

    for (const filter of ["已适配", "未适配"] as const) {
      chooseFilter(filter);
      expect(
        screen.queryByRole("button", { name: /详情/ }),
        filter,
      ).not.toBeInTheDocument();
    }

    const okRow = screen
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("不可用的源"));
    fireEvent.click(okRow as HTMLElement);

    expect(screen.getByText(/适配器边界/)).toBeInTheDocument();
  });

  it("keeps the page itself from scrolling and gives the list the scrollbar", () => {
    // The list is the tallest thing here; letting the page scroll as a whole pushed the controls
    // out of view. jsdom cannot measure overflow, so the class contract is what is pinned.
    renderCenter();

    const page = screen.getByRole("heading", { name: "配置中心" })
      .closest("div.flex.h-full");
    expect(page?.className).toContain("overflow-hidden");
    expect(page?.className).not.toContain("overflow-auto");
  });

  it("labels the test button for assistive technology instead of showing text", () => {
    renderCenter();

    expect(
      screen.getByRole("button", { name: "测试 可用的源" }),
    ).toBeInTheDocument();
  });

  it("moves import, export and bulk test next to the list they act on", () => {
    // In the page header, "导出" gave no clue what it exported; beside the list it is unambiguous.
    renderCenter();

    expect(
      screen.getByRole("button", { name: /导出此配置/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /导入配置/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /全部测速/ }),
    ).toBeInTheDocument();
  });

  it("keeps the list searchable", () => {
    renderCenter();

    fireEvent.change(screen.getByPlaceholderText("搜索源名称或 API"), {
      target: { value: "可用" },
    });

    expect(screen.getByText("可用的源")).toBeInTheDocument();
    expect(screen.queryByText("不可用的源")).not.toBeInTheDocument();
  });

  it("reports how many sources are showing, without an unexplained pass count", () => {
    // "已通过 N 个" left the reader guessing what had passed — a test? a filter? The list is
    // already the answer, so only the size of the result is stated.
    renderCenter();

    expect(screen.getByText("共 1 个")).toBeInTheDocument();
    expect(screen.queryByText(/已通过/)).not.toBeInTheDocument();
  });

  it("offers no action button in the empty state", () => {
    // Nothing to clear: the filter is a control the user can see and change, so a second button
    // for the same thing only raised the question of what else it might reset.
    renderCenter();

    fireEvent.change(screen.getByPlaceholderText("搜索源名称或 API"), {
      target: { value: "不存在的关键词" },
    });

    expect(screen.getByText("没有匹配的源")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /清除筛选/ }),
    ).not.toBeInTheDocument();
  });

  it("explains an empty usable list instead of just saying nothing matched", () => {
    // When every source is unusable, "没有匹配的源" implies the filter is wrong when in fact the
    // configuration has nothing usable in it.
    useAppStore.setState({
      sources: [blocked, needsAdapter],
      rawConfig: JSON.stringify({ sites: [] }),
      normalizedConfig: JSON.stringify({ sites: [] }),
      configDocuments: [
        { id: 1, name: "主配置", sourceCount: 2, liveCount: 0, importedAt: "2026-01-01T00:00:00.000Z" },
      ],
      configDocumentCache: {},
      activeConfigId: 1,
      lastImportedAt: "2026-01-01T00:00:00.000Z",
    });
    renderPage(<ConfigCenter />);

    expect(screen.getByText("当前配置没有已适配的源")).toBeInTheDocument();
    expect(screen.getByText(/切换到「未适配」/)).toBeInTheDocument();
  });

  it("insets the empty state from the card edge", () => {
    // The card's content area carries no padding (the table brings its own), so an empty state
    // dropped straight into it pressed its dashed border against the card border. jsdom cannot
    // measure the gap, but it can confirm the wrapper that creates it.
    renderCenter();

    fireEvent.change(screen.getByPlaceholderText("搜索源名称或 API"), {
      target: { value: "不存在的关键词" },
    });

    const empty = screen.getByText("没有匹配的源").closest("[data-slot='empty']");
    expect(empty).toBeTruthy();
    expect(empty?.parentElement?.className).toContain("p-4");
  });

  it("offers a delete button on every row", () => {
    // Removing a source is a normal part of tidying a configuration, so the control is on every
    // row rather than only on the ones that look broken.
    renderCenter();

    expect(
      screen.getByRole("button", { name: "删除 可用的源" }),
    ).toBeInTheDocument();

    chooseFilter("未适配");
    expect(
      screen.getByRole("button", { name: "删除 不可用的源" }),
    ).toBeInTheDocument();
  });

  it("deletes an unusable source without a confirmation prompt", () => {
    // Tidying away a source that cannot run is the ordinary case, so it does not interrupt.
    const removeSources = vi.fn(async () => undefined);
    useAppStore.setState({ removeSources });
    renderCenter();
    chooseFilter("未适配");

    fireEvent.click(screen.getByRole("button", { name: "删除 不可用的源" }));

    expect(removeSources).toHaveBeenCalledWith(["no"]);
    expect(screen.queryByText("从配置中删除这些源？")).not.toBeInTheDocument();
  });

  it("asks before deleting a source that works", () => {
    // Discarding something usable is the surprising case, so only that one asks.
    const removeSources = vi.fn(async () => undefined);
    useAppStore.setState({ removeSources });
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: "删除 可用的源" }));

    expect(removeSources).not.toHaveBeenCalled();
    expect(screen.getByText("从配置中删除这些源？")).toBeInTheDocument();
    expect(screen.getByText(/原始配置会被一起修改/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    return waitFor(() => {
      expect(removeSources).toHaveBeenCalledWith(["ok"]);
    });
  });

  it("does not delete a usable source when the dialog is dismissed", () => {
    const removeSources = vi.fn(async () => undefined);
    useAppStore.setState({ removeSources });
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: "删除 可用的源" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(removeSources).not.toHaveBeenCalled();
  });

  it("asks for confirmation before clearing every unusable source", async () => {
    const removeSources = vi.fn(async () => undefined);
    useAppStore.setState({ removeSources });
    renderCenter();
    chooseFilter("未适配");

    const bulk = screen.getByRole("button", { name: /清理不可用/ });
    // Two of the three fixture sources cannot run.
    expect(bulk.textContent).toContain("2");

    fireEvent.click(bulk);

    expect(removeSources).not.toHaveBeenCalled();
    expect(screen.getByText(/这些无法工作的源/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(removeSources).toHaveBeenCalledWith(["no", "wait"]);
    });
  });

  it("clears only the rows the current search is showing", async () => {
    // A bulk action that reaches rows outside the current view deletes things the user cannot
    // see. The search narrows the list, so the cleanup must narrow with it.
    const removeSources = vi.fn(async () => undefined);
    useAppStore.setState({ removeSources });
    renderCenter();
    chooseFilter("未适配");
    // "待适配的源" is the needs-adapter fixture; "不可用的源" is the blocked one.
    fireEvent.change(screen.getByPlaceholderText("搜索源名称或 API"), {
      target: { value: "待适配" },
    });

    const bulk = screen.getByRole("button", { name: /清理不可用/ });
    expect(bulk.textContent).toContain("1");

    fireEvent.click(bulk);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(removeSources).toHaveBeenCalledWith(["wait"]);
    });
    // The blocked source was not on screen, so it must not have been touched.
    expect(removeSources).not.toHaveBeenCalledWith(["no"]);
  });

  it("shows the bulk cleanup only where unusable sources are on screen", () => {
    // Acting on rows the user cannot see is what makes a bulk button dangerous.
    renderCenter();

    expect(
      screen.queryByRole("button", { name: /清理不可用/ }),
    ).not.toBeInTheDocument();

    chooseFilter("未适配");
    expect(
      screen.getByRole("button", { name: /清理不可用/ }),
    ).toBeInTheDocument();

    chooseFilter("全部");
    expect(
      screen.getByRole("button", { name: /清理不可用/ }),
    ).toBeInTheDocument();
  });

  it("hides the bulk cleanup when every source is usable", () => {
    useAppStore.setState({
      sources: [supported],
      rawConfig: JSON.stringify({ sites: [] }),
      normalizedConfig: JSON.stringify({ sites: [] }),
      configDocuments: [
        { id: 1, name: "主配置", sourceCount: 1, liveCount: 0, importedAt: "2026-01-01T00:00:00.000Z" },
      ],
      configDocumentCache: {},
      activeConfigId: 1,
      lastImportedAt: "2026-01-01T00:00:00.000Z",
    });
    renderPage(<ConfigCenter />);

    expect(
      screen.queryByRole("button", { name: /清理不可用/ }),
    ).not.toBeInTheDocument();
  });

  it("reports a finished test as a toast, not as a banner left on the page", async () => {
    // The result of one operation used to sit in a banner below the list until the next action
    // replaced it. A toast says the same thing once and leaves.
    vi.mocked(testSourceCommand).mockResolvedValue(testResult());
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: "测试 可用的源" }));

    await waitFor(() => {
      expect(screen.getByText(/测试通过/)).toBeInTheDocument();
    });
    expect(document.querySelector("[data-slot='toast']")).toBeTruthy();
    // The banner that used to carry this is gone.
    expect(document.querySelector("[data-slot='alert']")).toBeNull();
  });

  it("names a cancelled run as cancelled rather than a broken configuration", async () => {
    // Every error state was titled "需要修正配置", so a cancelled test claimed the imported
    // configuration file was malformed.
    vi.mocked(testSourceCommand).mockImplementation(
      () => new Promise<SourceTestResult>(() => {}),
    );
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: /全部测速/ }));
    fireEvent.click(await screen.findByRole("button", { name: /取消测速/ }));

    await waitFor(() => {
      expect(screen.getByText("测速已取消")).toBeInTheDocument();
    });
    expect(screen.queryByText("需要修正配置")).not.toBeInTheDocument();
  });

  it("says a source is untested rather than calling it usable", () => {
    // "可用" before anything has been fetched told the user the resource works when all we knew
    // was that we had a way to ask. The adapter running is a statement about our code.
    renderCenter();

    const okRow = screen
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("可用的源"));
    expect(within(okRow as HTMLElement).getByText("待测试")).toBeInTheDocument();
    expect(within(okRow as HTMLElement).queryByText("可用")).not.toBeInTheDocument();
  });

  it("calls a source usable only after a test found content", () => {
    useAppStore.setState({
      sources: [{ ...supported, testStatus: "passed", testItemCount: 12 }],
      rawConfig: JSON.stringify({ sites: [] }),
      normalizedConfig: JSON.stringify({ sites: [] }),
      configDocuments: [
        { id: 1, name: "主配置", sourceCount: 1, liveCount: 0, importedAt: "2026-01-01T00:00:00.000Z" },
      ],
      configDocumentCache: {},
      activeConfigId: 1,
      lastImportedAt: "2026-01-01T00:00:00.000Z",
    });
    renderPage(<ConfigCenter />);

    // Scoped to the row: "可用" also appears as a filter option.
    const okRow = screen
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("可用的源"));
    expect(within(okRow as HTMLElement).getByText("可用")).toBeInTheDocument();
    expect(within(okRow as HTMLElement).queryByText("待测试")).not.toBeInTheDocument();
  });

  it("reports a test that found nothing as 无内容 rather than usable", () => {
    useAppStore.setState({
      sources: [{ ...supported, testStatus: "empty" }],
      rawConfig: JSON.stringify({ sites: [] }),
      normalizedConfig: JSON.stringify({ sites: [] }),
      configDocuments: [
        { id: 1, name: "主配置", sourceCount: 1, liveCount: 0, importedAt: "2026-01-01T00:00:00.000Z" },
      ],
      configDocumentCache: {},
      activeConfigId: 1,
      lastImportedAt: "2026-01-01T00:00:00.000Z",
    });
    renderPage(<ConfigCenter />);

    expect(screen.getByText("无内容")).toBeInTheDocument();
  });

  it("tests several sources at once instead of one after another", async () => {
    // Serial testing made a large configuration take the sum of every source's latency. The
    // concurrency is proved by observing how many requests are open simultaneously.
    const pending: Array<(value: SourceTestResult) => void> = [];
    let maxConcurrent = 0;
    vi.mocked(testSourceCommand).mockImplementation(
      () =>
        new Promise<SourceTestResult>((resolve) => {
          pending.push(resolve);
          maxConcurrent = Math.max(maxConcurrent, pending.length);
        }),
    );
    useAppStore.setState({
      sources: [
        { ...supported, key: "a", name: "源一" },
        { ...supported, key: "b", name: "源二" },
        { ...supported, key: "c", name: "源三" },
      ],
      rawConfig: JSON.stringify({ sites: [] }),
      normalizedConfig: JSON.stringify({ sites: [] }),
      configDocuments: [
        { id: 1, name: "主配置", sourceCount: 3, liveCount: 0, importedAt: "2026-01-01T00:00:00.000Z" },
      ],
      configDocumentCache: {},
      activeConfigId: 1,
      lastImportedAt: "2026-01-01T00:00:00.000Z",
    });
    renderPage(<ConfigCenter />);

    fireEvent.click(screen.getByRole("button", { name: /全部测速/ }));

    await waitFor(() => {
      expect(pending.length).toBeGreaterThan(1);
    });
    expect(maxConcurrent).toBeGreaterThan(1);

    // Let every outstanding request finish so the run can settle.
    for (const resolve of pending) resolve(testResult());
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /取消测速/ })).not.toBeInTheDocument();
    });
  });

  it("offers a way to stop a batch that is running", async () => {
    // A batch used to be unstoppable: the button became a disabled "测速中" label and the only
    // way out was to wait for every source, including the ones that hang.
    vi.mocked(testSourceCommand).mockImplementation(
      () => new Promise<SourceTestResult>(() => {}),
    );
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: /全部测速/ }));

    const cancel = await screen.findByRole("button", { name: /取消测速/ });
    expect(cancel).toBeInTheDocument();

    fireEvent.click(cancel);

    // Cancelling ends the run and reports what was and was not covered, as a toast rather than a
    // banner left on the page.
    await waitFor(() => {
      expect(screen.getByText("测速已取消")).toBeInTheDocument();
    });
    expect(screen.getByText(/其余未测试的源保持原状态/)).toBeInTheDocument();
    expect(document.querySelector("[data-slot='toast']")).toBeTruthy();
  });

  it("marks the row being tested so it is clear which one is outstanding", async () => {
    vi.mocked(testSourceCommand).mockImplementation(
      () => new Promise<SourceTestResult>(() => {}),
    );
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: /全部测速/ }));

    await waitFor(() => {
      const blurred = document.querySelectorAll("tr.opacity-60");
      expect(blurred.length).toBeGreaterThan(0);
    });
  });

  it("lets a single row's test be cancelled from the row itself", async () => {
    // The row is where a user looks when they want it to stop, so the cancel control appears
    // there on hover rather than only in the toolbar. The button stays icon-only, so the state
    // is carried by the accessible name.
    vi.mocked(testSourceCommand).mockImplementation(
      () => new Promise<SourceTestResult>(() => {}),
    );
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: /全部测速/ }));

    const rowCancel = await screen.findByRole("button", {
      name: /取消测试 可用的源/,
    });
    expect(rowCancel).toBeInTheDocument();
  });

  it("switches off a source the test found unusable", async () => {
    // A source that fails or comes back empty stops being offered, so it no longer appears in
    // the library or in live.
    vi.mocked(testSourceCommand).mockResolvedValue(
      testResult({ status: "empty", itemCount: 0, message: "响应中没有内容。" }),
    );
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: "测试 可用的源" }));

    await waitFor(() => {
      expect(useAppStore.getState().sources[0].enabled).toBe(false);
    });
    expect(useAppStore.getState().sources[0].testStatus).toBe("empty");
  });

  it("leaves a source enabled when the test passes", async () => {
    vi.mocked(testSourceCommand).mockResolvedValue(testResult());
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: "测试 可用的源" }));

    await waitFor(() => {
      expect(useAppStore.getState().sources[0].testStatus).toBe("passed");
    });
    expect(useAppStore.getState().sources[0].enabled).toBe(true);
  });

  it("says in the toast that an unusable source was switched off", async () => {
    vi.mocked(testSourceCommand).mockResolvedValue(
      testResult({ status: "empty", itemCount: 0, message: "响应中没有内容。" }),
    );
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: "测试 可用的源" }));

    await waitFor(() => {
      expect(screen.getByText(/已自动关闭该源的启用开关/)).toBeInTheDocument();
    });
  });
});
