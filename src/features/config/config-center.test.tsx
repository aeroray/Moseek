import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return render(<ConfigCenter />);
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

    expect(screen.getByRole("option", { name: "可用" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "不可用" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "全部" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "部分可用" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "待适配" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "配置无效" })).not.toBeInTheDocument();
  });

  it("filters to the unusable sources when asked", () => {
    renderCenter();

    chooseFilter("不可用");

    expect(screen.getByText("不可用的源")).toBeInTheDocument();
    expect(screen.getByText("待适配的源")).toBeInTheDocument();
    expect(screen.queryByText("可用的源")).not.toBeInTheDocument();
  });

  it("states whether an adapter is working instead of repeating the status badge", () => {
    // The adapter cell showed the adapter's own execution badge, so a blocked source read
    // "已阻止" twice in the same row.
    renderCenter();
    chooseFilter("不可用");

    const rows = screen.getAllByRole("row");
    const blockedRow = rows.find((row) => row.textContent?.includes("不可用的源"));
    expect(blockedRow).toBeTruthy();
    expect(within(blockedRow as HTMLElement).getByText("未适配")).toBeInTheDocument();

    chooseFilter("可用");
    const okRow = screen
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("可用的源"));
    expect(within(okRow as HTMLElement).getByText("可执行")).toBeInTheDocument();
  });

  it("does not offer an enable switch for a source that cannot run", () => {
    // The switch moved and did nothing, which reads as the app ignoring the click. A dash is the
    // honest answer for "not applicable".
    renderCenter();

    expect(screen.getByRole("switch", { name: "启用 可用的源" })).toBeInTheDocument();

    chooseFilter("不可用");
    expect(
      screen.queryByRole("switch", { name: "启用 不可用的源" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "启用 待适配的源" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer a connection test for a source that cannot run", () => {
    // A test for a source with no working adapter can only fail, which tells the user nothing.
    // Those rows offer 详情 instead.
    renderCenter();
    chooseFilter("全部");

    expect(screen.getAllByRole("button", { name: /^测试$/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /详情/ })).toHaveLength(2);
  });

  it("points an unusable source at its details instead of a dead end", () => {
    renderCenter();
    chooseFilter("不可用");

    const detailButtons = screen.getAllByRole("button", { name: /详情/ });
    expect(detailButtons.length).toBeGreaterThan(0);

    fireEvent.click(detailButtons[0]);
    // The sheet opens with the source's own explanation.
    expect(screen.getByText(/适配器边界/)).toBeInTheDocument();
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
    render(<ConfigCenter />);

    expect(screen.getByText("当前配置没有可用的源")).toBeInTheDocument();
    expect(screen.getByText(/切换到「不可用」/)).toBeInTheDocument();
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

  it("offers to delete an unusable source, and only an unusable one", () => {
    // Pruning is how a user reduces a configuration to the part that works. Offering it for a
    // source that works would invite deleting the good ones.
    renderCenter();

    expect(
      screen.queryByRole("button", { name: "删除 可用的源" }),
    ).not.toBeInTheDocument();

    chooseFilter("不可用");
    expect(
      screen.getByRole("button", { name: "删除 不可用的源" }),
    ).toBeInTheDocument();
  });

  it("removes a source through the store after confirming in a dialog", async () => {
    // The confirmation is a real dialog rather than window.confirm: deleting rewrites the
    // configuration the user imported, so the risk has to be stated where it can be read.
    const removeSources = vi.fn(async () => undefined);
    useAppStore.setState({ removeSources });
    renderCenter();
    chooseFilter("不可用");

    fireEvent.click(screen.getByRole("button", { name: "删除 不可用的源" }));

    // Nothing happens until the dialog is confirmed.
    expect(removeSources).not.toHaveBeenCalled();
    expect(screen.getByText("从配置中删除这些源？")).toBeInTheDocument();
    expect(screen.getByText(/原始配置会被一起修改/)).toBeInTheDocument();
    expect(screen.getByText(/此操作不能撤销/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(removeSources).toHaveBeenCalledWith(["no"]);
    });
  });

  it("does not delete anything when the dialog is dismissed", () => {
    const removeSources = vi.fn(async () => undefined);
    useAppStore.setState({ removeSources });
    renderCenter();
    chooseFilter("不可用");

    fireEvent.click(screen.getByRole("button", { name: "删除 不可用的源" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(removeSources).not.toHaveBeenCalled();
  });

  it("asks for confirmation before clearing every unusable source", async () => {
    const removeSources = vi.fn(async () => undefined);
    useAppStore.setState({ removeSources });
    renderCenter();

    const bulk = screen.getByRole("button", { name: /清理不可用/ });
    // Two of the three fixture sources cannot run.
    expect(bulk.textContent).toContain("2");

    fireEvent.click(bulk);

    expect(removeSources).not.toHaveBeenCalled();
    expect(screen.getByText(/全部不可用的源/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(removeSources).toHaveBeenCalledWith(["no", "wait"]);
    });
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
    render(<ConfigCenter />);

    expect(
      screen.queryByRole("button", { name: /清理不可用/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the test result on the page, not only inside the import dialog", async () => {
    // The status banner used to live inside the import dialog, so every message it carried — a
    // finished test run, a cancelled one, a deleted source — was invisible unless the user
    // happened to have that dialog open.
    vi.mocked(testSourceCommand).mockResolvedValue(testResult());
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: /^测试$/ }));

    await waitFor(() => {
      expect(screen.getByText(/源审计完成/)).toBeInTheDocument();
    });
    expect(screen.queryByText("导入配置")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    render(<ConfigCenter />);

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
    render(<ConfigCenter />);

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
    render(<ConfigCenter />);

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

    // Cancelling ends the run and reports what was and was not covered.
    await waitFor(() => {
      expect(screen.getByText("测速已取消")).toBeInTheDocument();
    });
    expect(screen.getByText(/其余未测试的源保持原状态/)).toBeInTheDocument();
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
    // there on hover rather than only in the toolbar.
    vi.mocked(testSourceCommand).mockImplementation(
      () => new Promise<SourceTestResult>(() => {}),
    );
    renderCenter();

    fireEvent.click(screen.getByRole("button", { name: /全部测速/ }));

    const rowCancel = await screen.findByRole("button", { name: /测试中/ });
    expect(rowCancel.textContent).toContain("取消");
  });
});
