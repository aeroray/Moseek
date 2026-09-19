import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastHost } from "@/components/toast-host";
import { ToastProvider } from "@/components/ui/toast";
import { ConfigCenter } from "@/features/config/config-center";
import {
  activateConfigDocument,
  fetchConfigUrl,
  replaceAllConfigDocuments,
  saveConfigDocument,
  testSource as testSourceCommand,
} from "@/lib/tauri";
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
  replaceAllConfigDocuments: vi.fn(async (input) => ({
    id: 1,
    name: input.name,
    rawConfig: input.rawConfig,
    normalizedConfig: input.normalizedConfig,
    sources: input.sources,
    sourceCount: input.sources.length,
    liveCount: input.liveCount,
    importedAt: "刚刚",
    sourceBaseUrl: input.sourceBaseUrl ?? null,
  })),
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
// Genuinely unrunnable: a bare `type: 3` spider that ships a remote JAR, which is the case the
// adapter registry reports as blocked. The fixture used to be `csp_XBPQ` with an `xbpq` protocol —
// a source the XBPQ adapter *does* handle — so it asserted that a runnable source was unusable.
const blocked = source({
  key: "no",
  name: "不可用的源",
  capability: "blocked",
  capabilityNote: "检测到远程 JAR 依赖，Moseek 只记录和展示，不会下载或执行。",
  enabled: false,
  api: "https://blocked.example/spider",
  siteProtocol: "spider",
  jar: "https://blocked.example/1.jar",
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

/**
 * Renders the page the way the application actually mounts it.
 *
 * `src/main.tsx` wraps everything in `<StrictMode>`, which runs an effect, its cleanup, then the
 * effect again. A migration guarded by a ref set before the work began therefore never ran at all —
 * and every test here rendered without StrictMode, so none of them could see it.
 */
function renderPageStrict(ui: React.ReactElement) {
  return render(
    <StrictMode>
      <ToastProvider>
        <ToastHost>{ui}</ToastHost>
      </ToastProvider>
    </StrictMode>,
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

/** Opens the 适配器 tab. Radix switches tabs on pointer-down, not click. */
function openAdaptersTab() {
  const tab = screen.getByRole("tab", { name: "适配器" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

/** Opens the 原始配置 tab. Radix switches tabs on pointer-down, not click. */
function openRawTab() {
  const tab = screen.getByRole("tab", { name: "原始配置" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

/** Opens the 解析报告 tab. Radix switches tabs on pointer-down, not click. */
function openReportTab() {
  const tab = screen.getByRole("tab", { name: "解析报告" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

/**
 * The adapter card. The tab and the card title are both 适配器, so matching the text alone is
 * ambiguous; scope to the card that holds the adapter table or its empty state.
 */
function adapterCard() {
  const card = screen
    .getAllByText("适配器")
    .map((node) => node.closest("[data-slot='card']"))
    .find(Boolean);
  if (!card) throw new Error("adapter card not found");
  // Guard against matching a different card: the adapter card always holds the table or its
  // empty state, so a stray match would make the assertions below pass vacuously.
  if (!card.querySelector("[data-slot='table'], [data-slot='empty']")) {
    throw new Error("matched a card that is not the adapter card");
  }
  return card as HTMLElement;
}

/**
 * Opens the import dialog, loads configuration text through the remote-fetch control and confirms
 * the merge.
 *
 * The dialog's text editor is CodeMirror, which `fireEvent.change` cannot drive, so the test uses
 * the remote path: a real input whose fetch is mocked. That is also the path a user takes when
 * importing by URL, so the test still exercises the real controls rather than component internals.
 */
async function importConfigText(text: string, baseUrl = "https://imported.example/config.json") {
  vi.mocked(fetchConfigUrl).mockResolvedValue(text);
  fireEvent.click(screen.getByRole("button", { name: /导入配置/ }));
  const input = await screen.findByPlaceholderText("https://example.com/config.json5");
  fireEvent.change(input, { target: { value: baseUrl } });
  fireEvent.click(screen.getByRole("button", { name: /获取配置/ }));
  await waitFor(() => {
    expect(screen.getByLabelText("配置文本")).toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole("button", { name: /合并进中心配置/ }));
  await waitFor(() => {
    expect(replaceAllConfigDocuments).toHaveBeenCalled();
  });
}

describe("config center", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    // Call counts are asserted in a few tests, so the mocks must not carry over from earlier ones.
    vi.mocked(replaceAllConfigDocuments).mockClear();
    vi.mocked(activateConfigDocument).mockReset();
    vi.mocked(activateConfigDocument).mockResolvedValue(null);
  });

  it("names itself 配置中心", () => {
    // "配置与源" described the page's contents rather than its role; 配置中心 says what it is.
    renderCenter();

    expect(
      screen.getByRole("heading", { name: "配置中心" }),
    ).toBeInTheDocument();
  });

  it("states the single centre configuration instead of offering a switcher", () => {
    // The switcher existed because every import made a new document. Imports now merge, so there is
    // nothing to switch between; the row only reports what the configuration currently is.
    renderCenter();

    expect(screen.getByText("中心配置")).toBeInTheDocument();
    expect(screen.queryByLabelText("切换配置")).not.toBeInTheDocument();
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
    // outcome a user cares about. "清单" was the other awkward one: a list is just a list.
    renderCenter();

    expect(screen.getByRole("tab", { name: /源列表/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /源清单/ })).not.toBeInTheDocument();
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

  it("names the parse dialect in Chinese rather than printing the raw value", () => {
    // The map listed `json-http`, `http-extension` and `js-extension` — all SiteProtocol values that
    // can never reach it — and omitted `kitty`, which is a real member of SourceDialect. A CatVod
    // source therefore printed the bare English word "kitty" in an otherwise Chinese sheet.
    const kitty = source({
      key: "kitty1",
      name: "小猫源",
      sourceDialect: "kitty",
      api: "https://kitty.example/api",
    });
    const mixed = source({
      key: "mixed1",
      name: "混合源",
      sourceDialect: "mixed",
      api: "https://mixed.example/api",
    });
    renderCenter();
    act(() => {
      useAppStore.setState({ sources: [kitty, mixed] });
    });

    for (const name of ["小猫源", "混合源"]) {
      const row = screen
        .getAllByRole("row")
        .find((r) => r.textContent?.includes(name));
      fireEvent.click(row as HTMLElement);

      const sheet = screen.getByRole("dialog");
      expect(within(sheet).getByText("解析格式")).toBeInTheDocument();
      // The internal identifier is not what a user should read.
      expect(within(sheet).queryByText("kitty")).not.toBeInTheDocument();
      expect(within(sheet).queryByText("mixed")).not.toBeInTheDocument();

      fireEvent.keyDown(document, { key: "Escape" });
    }
  });

  it("does not repeat the source type inside the sheet", () => {
    // The header badge already states it, from the same expression, so the sheet said 普通 CMS
    // twice — once as a badge and once as a 基本信息 row.
    renderCenter();
    chooseFilter("未适配");

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("不可用的源"));
    fireEvent.click(row as HTMLElement);

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).queryByText("类型")).not.toBeInTheDocument();
    // The badge that legitimately carries it is still there.
    expect(within(sheet).getAllByText("普通 CMS")).toHaveLength(1);
  });

  it("does not repeat the API label as both a heading and a row", () => {
    // `<DetailSection title="接口地址">` immediately followed by `<DetailRow label="接口地址">`
    // read as a mistake.
    renderCenter();
    chooseFilter("未适配");

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("不可用的源"));
    fireEvent.click(row as HTMLElement);

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("接口地址")).toBeInTheDocument();
    expect(within(sheet).getByText("地址")).toBeInTheDocument();
  });

  it("shows a live source's guide and logo addresses", () => {
    // Both are parsed and stored, and the sheet showed neither, so they were only reachable by
    // reading the raw configuration text.
    const live = source({
      key: "live-1",
      name: "直播源",
      sourceType: "live",
      api: "https://live.example/tv.txt",
      epg: "https://epg.example/?ch={name}&date={date}",
      logo: "https://epg.example/logo/{name}.png",
    });
    renderCenter();
    act(() => {
      useAppStore.setState({ sources: [live] });
    });

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("直播源"));
    fireEvent.click(row as HTMLElement);

    const sheet = screen.getByRole("dialog");
    // 节目单 also names an adapter operation, so the label is looked up inside the address list.
    expect(
      within(sheet).getByText("https://epg.example/?ch={name}&date={date}"),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText("https://epg.example/logo/{name}.png"),
    ).toBeInTheDocument();
  });

  it("hides 配置声明可用 when the configuration did not switch the source off", () => {
    // It read 是 for all 355 sources in the author's database, so the row was a constant.
    renderCenter();
    chooseFilter("未适配");

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("不可用的源"));
    fireEvent.click(row as HTMLElement);

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).queryByText("配置声明可用")).not.toBeInTheDocument();
  });

  it("does not offer to enable a source the list says cannot run", () => {
    // The list draws a dash for such a row. The footer offered 启用此源 anyway, flipping a flag
    // nothing reads — `enabled` only gates the movie library, and an unrunnable source is excluded
    // from it either way — so the two surfaces disagreed about whether the control existed.
    renderCenter();
    chooseFilter("未适配");

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("不可用的源"));
    fireEvent.click(row as HTMLElement);

    const sheet = screen.getByRole("dialog");
    expect(
      within(sheet).queryByRole("button", { name: /启用此源|停用此源/ }),
    ).not.toBeInTheDocument();
    expect(within(sheet).getByText(/无法启用/)).toBeInTheDocument();
    // And no test button either, since there is nothing to test with.
    expect(
      within(sheet).queryByRole("button", { name: "测试" }),
    ).not.toBeInTheDocument();
  });

  it("still offers the switch for a source that can run", () => {
    // The counterpart, so the guard above cannot be satisfied by removing the control everywhere.
    renderCenter();

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("可用的源"));
    fireEvent.click(row as HTMLElement);

    const sheet = screen.getByRole("dialog");
    expect(
      within(sheet).getByRole("button", { name: /停用此源|启用此源/ }),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "测试" })).toBeInTheDocument();
  });

  it("does not print a stale stored note under the source name", () => {
    // `capabilityNote` is written at import and never refreshed. Measured on the author's database,
    // 101 of 355 notes no longer matched the code, and 69 of those told the reader the source was
    // blocked while its adapter runs it.
    const stale = source({
      key: "stale",
      name: "状态过期的源",
      capability: "blocked",
      capabilityNote: "API 部分可用；存在远程 JAR 依赖，Moseek 不会下载或执行。",
      api: "csp_XBPQ",
      siteProtocol: "xbpq",
    });
    renderCenter();
    act(() => {
      useAppStore.setState({ sources: [stale] });
    });

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("状态过期的源"));
    fireEvent.click(row as HTMLElement);

    const sheet = screen.getByRole("dialog");
    expect(
      within(sheet).queryByText(/API 部分可用/),
    ).not.toBeInTheDocument();
    // The adapter's own explanation still appears, in 适配器边界 — and only once, since printing it
    // under the title as well said the same paragraph twice in one sheet.
    expect(
      within(sheet).getAllByText(/按 URL 模板与文本标记读取页面/),
    ).toHaveLength(1);
  });

  it("keeps the parser's note for a record that cannot be parsed", () => {
    // The adapter says nothing about missing fields, which is the actual problem, so the parser's
    // note is the only one that explains it.
    const broken = source({
      key: "broken",
      name: "无效源",
      capability: "invalid",
      capabilityNote: "缺少 key、name 或 api 必填字段，无法建立安全的源记录。",
      api: "",
    });
    renderCenter();
    act(() => {
      useAppStore.setState({ sources: [broken] });
    });
    chooseFilter("未适配");

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("无效源"));
    fireEvent.click(row as HTMLElement);

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText(/缺少 key、name 或 api/)).toBeInTheDocument();
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

  it("gives the adapter list its own scroll region, like the source list", () => {
    // Without it the adapter table ran past the bottom of the card instead of scrolling inside it.
    renderCenter();
    openAdaptersTab();

    const card = adapterCard();
    const scroller = card.querySelector("[data-slot='scroll-area']");
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain("min-h-0");
  });

  it("sizes the raw editor from the space left, not a fixed height", () => {
    // A fixed 680px editor made the card 938px tall in an 805px window. The page is
    // overflow-hidden, so the bottom of the editor and the last lines of the configuration were
    // unreachable. jsdom cannot measure this, so the contract that makes it fit is what is pinned.
    renderCenter();
    openRawTab();

    const card = screen
      .getAllByText("原始配置文本")
      .map((node) => node.closest("[data-slot='card']"))
      .find(Boolean);
    expect(card?.className).toContain("min-h-0");
    expect(card?.className).toContain("flex-1");

    const editor = card?.querySelector("[data-slot='scroll-area']");
    expect(editor?.className).toContain("min-h-0");
    expect(editor?.className).toContain("flex-1");
    // No viewport-derived height: that is what overflowed the window.
    expect(editor?.className).not.toMatch(/h-\[min\(/);
    expect(editor?.className).not.toContain("min-h-[520px]");
  });

  it("gives the adapter list the same toolbar as the source list", () => {
    // Both lists are read the same way — search, then filter, then a count — so a reader who has
    // used one already knows how to use the other. The adapter tab used to have no search at all,
    // and its counts sat on a separate line as a second set of controls doing the filter's job.
    renderCenter();
    openAdaptersTab();

    const card = adapterCard();
    expect(
      within(card).getByPlaceholderText("搜索适配器名称或说明"),
    ).toBeInTheDocument();
    expect(within(card).getByLabelText("筛选适配器")).toBeInTheDocument();
    // The count reads the same as the source list's.
    expect(within(card).getByText(/^共 \d+ 类$/)).toBeInTheDocument();
  });

  it("narrows the adapter list by search", () => {
    renderCenter();
    openAdaptersTab();

    const card = adapterCard();
    const bodyRows = () =>
      within(card)
        .getAllByRole("row")
        .filter((row) => row.closest("tbody"));
    const rowsBefore = bodyRows().length;

    fireEvent.change(screen.getByPlaceholderText("搜索适配器名称或说明"), {
      target: { value: "脚本" },
    });

    const rows = bodyRows();
    expect(rows.length).toBeLessThan(rowsBefore);
    // Everything left matches the keyword, so the search is not just hiding rows arbitrarily.
    for (const row of rows) {
      expect(row.textContent).toMatch(/脚本/);
    }
  });

  it("counts adapters in the filter, not sources", () => {
    // The number beside a filter option has to answer "how many rows will I get". It counted
    // sources instead, so it read "可执行 26 个源" next to a choice that revealed 9 rows.
    renderCenter();
    openAdaptersTab();

    const trigger = screen.getByLabelText("筛选适配器");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    const enabled = screen.getByRole("option", { name: /可执行/ });
    const claimed = Number(enabled.textContent?.replace(/\D/g, "") ?? "0");
    expect(claimed).toBeGreaterThan(0);

    // Choosing it must yield exactly that many adapter rows.
    fireEvent.click(enabled);
    const card = adapterCard();
    const bodyRows = within(card)
      .getAllByRole("row")
      .filter((row) => row.closest("tbody"));
    expect(bodyRows.length).toBe(claimed);
  });

  it("updates the count as the search narrows the list", () => {
    // The count is the feedback that the search did something; a stale count beside a filtered
    // list is worse than no count.
    renderCenter();
    openAdaptersTab();

    const card = adapterCard();
    const countBefore = within(card).getByText(/^共 \d+ 类$/).textContent;

    fireEvent.change(screen.getByPlaceholderText("搜索适配器名称或说明"), {
      target: { value: "脚本" },
    });

    const countAfter = within(card).getByText(/^共 \d+ 类$/).textContent;
    expect(countAfter).not.toBe(countBefore);
    const claimed = Number(countAfter?.replace(/\D/g, "") ?? "0");
    const bodyRows = within(card)
      .getAllByRole("row")
      .filter((row) => row.closest("tbody"));
    expect(bodyRows.length).toBe(claimed);
  });

  it("explains an empty search result in terms of the search", () => {
    // "切换筛选条件" was the only hint, but a keyword that matches nothing is not a filter problem.
    renderCenter();
    openAdaptersTab();

    fireEvent.change(screen.getByPlaceholderText("搜索适配器名称或说明"), {
      target: { value: "不存在的适配器名字" },
    });

    expect(screen.getByText("没有匹配的适配器")).toBeInTheDocument();
    expect(screen.getByText(/换个关键词/)).toBeInTheDocument();
  });

  it("never shows 部分支持, which no code path could produce", () => {
    // The state was removed from the model: the parser assigns only supported / needs-adapter /
    // blocked / invalid, and no adapter profile claims partial execution. It survived in stored
    // data from an older version, where the list rendered 部分支持 beside an adapter badge reading
    // 没有可用适配器 — a row that said both "partly works" and "nothing can run it".
    //
    // The value is injected as unmigrated data on purpose: the store rewrites it on load, and the
    // component must not resurrect the wording if one ever reaches it another way.
    renderCenter();
    act(() => {
      useAppStore.setState({
        sources: [
          source({
            key: "legacy",
            name: "旧状态源",
            capability: "partial" as never,
            api: "proxy://legacy",
          }),
        ],
      });
    });
    chooseFilter("未适配");

    expect(screen.queryByText("部分支持")).not.toBeInTheDocument();
    // It falls back to the adapter's verdict, which is a word the model still has.
    expect(screen.getByText("待适配")).toBeInTheDocument();
  });

  it("lets the adapter, not a stale capability, word the status column", () => {
    // A source whose stored capability claims more than its adapter can do. The status column used
    // to render the capability, so this row read 可执行 next to an adapter badge saying 已阻止.
    // The fixture is deliberately contradictory: that is the whole point.
    renderCenter();
    act(() => {
      useAppStore.setState({
        sources: [
          source({
            key: "overstated",
            name: "状态虚高的源",
            capability: "supported",
            api: "https://overstated.example/spider",
            siteProtocol: "spider",
            jar: "https://overstated.example/1.jar",
          }),
        ],
      });
    });
    chooseFilter("未适配");

    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("状态虚高的源"));
    expect(row).toBeTruthy();
    const text = (row as HTMLElement).textContent ?? "";
    // Both columns agree the adapter cannot run it.
    expect(text).toContain("已阻止");
    expect(text).not.toContain("可执行");
  });

  it("says the same thing in the status and adapter columns", () => {
    // The two columns answer two questions, but they must never contradict: a row cannot claim a
    // capability while the adapter beside it says there is nothing to run. Both are now driven by
    // the adapter registry, so the wording agrees by construction.
    renderCenter();
    chooseFilter("未适配");

    const rowFor = (name: string) => {
      const cell = screen
        .getAllByRole("row")
        .find((row) => row.textContent?.includes(name));
      expect(cell).toBeTruthy();
      return (cell as HTMLElement).textContent ?? "";
    };

    // A source with no runnable adapter reads 已阻止 in both columns.
    const blockedRow = rowFor("不可用的源");
    expect(blockedRow).toContain("已阻止");
    expect(blockedRow).not.toContain("可执行");
    // And the state that used to appear here is gone for good.
    expect(blockedRow).not.toContain("部分支持");

    // A runnable one reads 已有适配器 in the adapter column while the status column reports the
    // test, which is a different question and is allowed to say 待测试. The adapter cell leads with
    // an icon whose accessible name carries the verdict, so that is what is asserted.
    chooseFilter("已适配");
    const supportedRow = rowFor("可用的源");
    expect(supportedRow).toContain("已有适配器");
    expect(supportedRow).toContain("待测试");
    expect(supportedRow).not.toContain("部分支持");
  });

  it("offers the enable switch only where the adapter can run the source", () => {
    // A switch on a row the page itself calls unrunnable invites a click that does nothing. This
    // reads the same predicate the status column does, so the two cannot drift apart.
    useAppStore.setState({
      sources: [supported, blocked],
      rawConfig: JSON.stringify({ sites: [] }),
    });
    renderCenter();

    expect(
      screen.getByRole("switch", { name: "启用 可用的源" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "启用 不可用的源" }),
    ).not.toBeInTheDocument();
  });

  it("treats a source with a working adapter as usable despite a stale capability", () => {
    // The stored capability records what the parser concluded at import time and is never
    // revisited; the adapter registry describes the code that exists now. Measured on the author's
    // database, 60 sources with a working XBPQ adapter were untestable and missing from the movie
    // library purely because their stored capability predated that support.
    const stale = source({
      key: "stale",
      name: "状态过期的源",
      capability: "blocked",
      capabilityNote: "旧版本写入的状态。",
      api: "csp_XBPQ",
      siteProtocol: "xbpq",
    });
    // The state is set before rendering: `renderCenter` seeds the store, and a `setState` afterwards
    // would not reach the already-mounted component.
    renderCenter();
    act(() => {
      useAppStore.setState({ sources: [stale] });
    });

    // It appears in the usable list, which is the behaviour that was broken: the stale capability
    // kept it out even though the adapter registry can run it.
    expect(screen.getByText("状态过期的源")).toBeInTheDocument();
    // And it is offered a switch, so the user can act on it.
    expect(
      screen.getByRole("switch", { name: "启用 状态过期的源" }),
    ).toBeInTheDocument();
  });

  it("offers a shorter adapter filter without the state nothing maps to", () => {
    // 部分支持 has no adapter in the registry, so offering it as a filter was a choice that
    // always came back empty.
    renderCenter();
    openAdaptersTab();

    const trigger = screen.getByLabelText("筛选适配器");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    expect(screen.getByRole("option", { name: /全部适配器/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /可执行/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /待适配/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /已阻止/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /部分支持/ }),
    ).not.toBeInTheDocument();
  });

  it("names the adapter tab in plain words", () => {
    renderCenter();

    // "矩阵" was the hard word; the tab now just says what the panel holds.
    expect(screen.getByRole("tab", { name: "适配器" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /矩阵/ })).not.toBeInTheDocument();
  });

  it("gives the adapter filter an icon, like the source list's", () => {
    renderCenter();
    openAdaptersTab();

    expect(
      screen.getByLabelText("筛选适配器").querySelector("svg"),
    ).not.toBeNull();
  });

  it("uses the same word for a count as for the badge it leads to", () => {
    // The count said 可执行 while the rows it revealed were badged 已启用, so clicking "3 个源"
    // left the reader hunting for three rows that did not appear to exist.
    renderCenter();
    openAdaptersTab();

    const trigger = screen.getByLabelText("筛选适配器");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /可执行/ }));

    const card = adapterCard();
    expect(within(card).getAllByText("可执行").length).toBeGreaterThan(0);
    expect(within(card).queryByText("已启用")).not.toBeInTheDocument();
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

  it("leads the report with a verdict instead of eight equal cards", () => {
    // Every finding was its own bordered card, so a fatal parse failure and a zero-count security
    // note looked identical and the reader had to read all eight to find the one that mattered.
    renderCenter();
    openReportTab();

    expect(screen.getByText(/配置解析成功，已识别 \d+ 个源/)).toBeInTheDocument();
    // The verdict is a single statement, not a card per field.
    expect(screen.queryByText("结构解析")).not.toBeInTheDocument();
  });

  it("groups the report into content and execution boundaries", () => {
    renderCenter();
    openReportTab();

    expect(screen.getByText("内容")).toBeInTheDocument();
    expect(screen.getByText("执行边界")).toBeInTheDocument();
    expect(screen.getByText("可搜索的源")).toBeInTheDocument();
    expect(screen.getByText("HTTP 解析服务")).toBeInTheDocument();
  });

  it("collapses a boundary that fired on nothing into one honest line", () => {
    // Three rows each saying "0 个已阻止" is noise; the reader needs to know nothing was blocked,
    // and that is one sentence. The fixture config has no JAR, no private protocol and nothing
    // blocked, so the collapsed form is what should render.
    renderCenter();
    openReportTab();

    expect(screen.getByText("没有需要阻止的内容")).toBeInTheDocument();
    expect(screen.queryByText("远程依赖")).not.toBeInTheDocument();
    expect(screen.queryByText("危险执行路径")).not.toBeInTheDocument();
  });

  it("merges an imported configuration into the centre configuration", async () => {
    // The point of the feature: the user maintains one configuration, so an import adds to what is
    // there instead of becoming a second document to keep track of.
    renderCenter();
    await importConfigText(
      JSON.stringify({
        sites: [
          { key: "新源", name: "新源", type: 1, api: "https://new.example/api.php/provide/vod" },
        ],
      }),
    );

    const saved = vi.mocked(replaceAllConfigDocuments).mock.calls.at(-1)?.[0];
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!.rawConfig) as { sites: { key: string }[] };
    const keys = parsed.sites.map((site) => site.key);
    // The existing source is still there and the imported one joined it.
    expect(keys).toContain("ok");
    expect(keys).toContain("新源");
  });

  it("does not create a second document when importing", async () => {
    // A regression here would quietly rebuild the pile of documents this replaced.
    renderCenter();
    await importConfigText(
      JSON.stringify({
        sites: [{ key: "x", name: "x", type: 1, api: "https://x.example/api.php/provide/vod" }],
      }),
    );

    expect(replaceAllConfigDocuments).toHaveBeenCalled();
    expect(saveConfigDocument).not.toHaveBeenCalled();
  });

  it("reports what the merge changed", async () => {
    // A merge that silently altered the source list would leave the user unsure whether their
    // configuration had been replaced. The summary is on the page, not in the dialog, so it is
    // still there after the dialog closes.
    renderCenter();
    await importConfigText(
      JSON.stringify({
        sites: [
          { key: "新源", name: "新源", type: 1, api: "https://new.example/api.php/provide/vod" },
        ],
      }),
    );

    expect(await screen.findByText(/已合并进/)).toBeInTheDocument();
    expect(screen.getByText(/新增 1 个源/)).toBeInTheDocument();
  });

  it("deduplicates a source the import repeats under a different key", async () => {
    // This is the case that makes merging worth having: the same site arrives again from another
    // configuration under a different label, and the user should end up with one row, not two.
    renderCenter();
    await importConfigText(
      JSON.stringify({
        sites: [
          {
            key: "别的名字",
            name: "别的名字",
            type: 1,
            api: supported.api,
          },
        ],
      }),
    );

    const saved = vi.mocked(replaceAllConfigDocuments).mock.calls.at(-1)?.[0];
    const parsed = JSON.parse(saved!.rawConfig) as { sites: { key: string }[] };
    // The fixture's raw config holds two sites; the import repeats one of them, so a third entry
    // would mean the duplicate was appended instead of matched.
    expect(parsed.sites).toHaveLength(2);
    // The repeated site kept its position but took the incoming definition.
    expect(parsed.sites[0].key).toBe("别的名字");

    // The source list is unchanged in size for the same reason: nothing was appended.
    expect(saved!.sources).toHaveLength(3);
    const identities = saved!.sources.map((s) => `${s.api}|${s.ext ?? ""}`);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("keeps the user's own switch when the same source is imported again", async () => {
    // Whether a source is switched on is the user's choice; an import has no business resetting it.
    renderCenter();
    useAppStore.setState({
      sources: [{ ...supported, enabled: false }],
    });

    await importConfigText(
      JSON.stringify({
        sites: [{ key: "ok", name: "可用的源", type: 1, api: supported.api }],
      }),
    );

    const saved = vi.mocked(replaceAllConfigDocuments).mock.calls.at(-1)?.[0];
    expect(saved!.sources[0].enabled).toBe(false);
  });

  it("collapses a database that still holds several configurations", async () => {
    // Moseek keeps one configuration now, so the first launch after upgrading has to merge the
    // documents an older version left behind.
    const documents = [
      { id: 1, name: "第一套", sourceCount: 1, liveCount: 0, importedAt: "2026-01-01T00:00:00.000Z" },
      { id: 2, name: "第二套", sourceCount: 1, liveCount: 0, importedAt: "2026-01-02T00:00:00.000Z" },
    ];
    const rawFor = (key: string, api: string) =>
      JSON.stringify({ sites: [{ key, name: key, type: 1, api }] });

    useAppStore.setState({
      sources: [supported],
      rawConfig: rawFor("first", "https://first.example/api.php/provide/vod"),
      normalizedConfig: "{}",
      configDocuments: documents,
      configDocumentCache: {},
      activeConfigId: 1,
      lastImportedAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(activateConfigDocument).mockImplementation(async (id: number) => ({
      id,
      name: id === 1 ? "第一套" : "第二套",
      rawConfig:
        id === 1
          ? rawFor("first", "https://first.example/api.php/provide/vod")
          : rawFor("second", "https://second.example/api.php/provide/vod"),
      normalizedConfig: "{}",
      sources: [supported],
      sourceCount: 1,
      liveCount: 0,
      importedAt: "2026-01-01T00:00:00.000Z",
      sourceBaseUrl: null,
    }));

    renderPageStrict(<ConfigCenter />);

    await waitFor(() => {
      expect(replaceAllConfigDocuments).toHaveBeenCalled();
    });
    const saved = vi.mocked(replaceAllConfigDocuments).mock.calls.at(-1)?.[0];
    const sites = (JSON.parse(saved!.rawConfig) as { sites: { key: string }[] }).sites;
    // Both configurations contributed a source.
    expect(sites.map((s) => s.key).sort()).toEqual(["first", "second"]);
    // And the store is left holding exactly one document.
    await waitFor(() => {
      expect(useAppStore.getState().configDocuments).toHaveLength(1);
    });
  });

  it("collapses even though StrictMode remounts the effect", async () => {
    // The application mounts inside <StrictMode>, which runs an effect, its cleanup, then the effect
    // again. The collapse used to mark itself "attempted" before doing anything, so the first run's
    // cleanup cancelled the work and the second run refused to start: the database kept all three
    // documents and the page showed a different one each visit. This is the test that would have
    // caught it — every other test here renders without StrictMode.
    const documents = [
      { id: 1, name: "第一套", sourceCount: 1, liveCount: 0, importedAt: "2026-01-01T00:00:00.000Z" },
      { id: 2, name: "第二套", sourceCount: 1, liveCount: 0, importedAt: "2026-01-02T00:00:00.000Z" },
      { id: 3, name: "第三套", sourceCount: 1, liveCount: 0, importedAt: "2026-01-03T00:00:00.000Z" },
    ];
    const rawFor = (key: string) =>
      JSON.stringify({
        sites: [{ key, name: key, type: 1, api: `https://${key}.example/api.php/provide/vod` }],
      });

    useAppStore.setState({
      sources: [supported],
      rawConfig: rawFor("one"),
      normalizedConfig: "{}",
      configDocuments: documents,
      configDocumentCache: {},
      activeConfigId: 1,
      lastImportedAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(activateConfigDocument).mockImplementation(async (id: number) => ({
      id,
      name: `第 ${id} 套`,
      rawConfig: rawFor(["one", "two", "three"][id - 1] ?? "x"),
      normalizedConfig: "{}",
      sources: [supported],
      sourceCount: 1,
      liveCount: 0,
      importedAt: "2026-01-01T00:00:00.000Z",
      sourceBaseUrl: null,
    }));

    renderPageStrict(<ConfigCenter />);

    await waitFor(() => {
      expect(replaceAllConfigDocuments).toHaveBeenCalledTimes(1);
    });
    const saved = vi.mocked(replaceAllConfigDocuments).mock.calls.at(-1)?.[0];
    const sites = (JSON.parse(saved!.rawConfig) as { sites: { key: string }[] }).sites;
    expect(sites).toHaveLength(3);
    await waitFor(() => {
      expect(useAppStore.getState().configDocuments).toHaveLength(1);
    });
  });

  it("survives the active document being reordered mid-collapse", async () => {
    // `setConfigDocument` moves the activated document to the front of `configDocuments`. When the
    // collapse effect depended on that array, the reorder re-ran the effect and its cleanup
    // cancelled the collapse before it wrote anything — the migration silently did nothing.
    const documents = [
      { id: 1, name: "第一套", sourceCount: 1, liveCount: 0, importedAt: "2026-01-01T00:00:00.000Z" },
      { id: 2, name: "第二套", sourceCount: 1, liveCount: 0, importedAt: "2026-01-02T00:00:00.000Z" },
      { id: 3, name: "第三套", sourceCount: 1, liveCount: 0, importedAt: "2026-01-03T00:00:00.000Z" },
    ];
    const rawFor = (key: string) =>
      JSON.stringify({
        sites: [{ key, name: key, type: 1, api: `https://${key}.example/api.php/provide/vod` }],
      });

    useAppStore.setState({
      sources: [supported],
      rawConfig: rawFor("one"),
      normalizedConfig: "{}",
      configDocuments: documents,
      configDocumentCache: {},
      activeConfigId: 1,
      lastImportedAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(activateConfigDocument).mockImplementation(async (id: number) => {
      const key = ["one", "two", "three"][id - 1] ?? "x";
      // Reordering the store here is what used to break the collapse.
      useAppStore.setState((state) => ({
        configDocuments: [
          ...state.configDocuments.filter((d) => d.id === id),
          ...state.configDocuments.filter((d) => d.id !== id),
        ],
      }));
      return {
        id,
        name: `第 ${id} 套`,
        rawConfig: rawFor(key),
        normalizedConfig: "{}",
        sources: [supported],
        sourceCount: 1,
        liveCount: 0,
        importedAt: "2026-01-01T00:00:00.000Z",
        sourceBaseUrl: null,
      };
    });

    renderPage(<ConfigCenter />);

    await waitFor(() => {
      expect(replaceAllConfigDocuments).toHaveBeenCalled();
    });
    const saved = vi.mocked(replaceAllConfigDocuments).mock.calls.at(-1)?.[0];
    const sites = (JSON.parse(saved!.rawConfig) as { sites: { key: string }[] }).sites;
    expect(sites).toHaveLength(3);
  });
});
