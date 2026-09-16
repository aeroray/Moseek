import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigCenter } from "@/features/config/config-center";
import { useAppStore } from "@/stores/app-store";
import type { SourceRecord } from "@/types/moseek";

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

  it("states whether an adapter is working instead of repeating the status badge", () => {
    // The adapter cell showed the adapter's own execution badge, so a blocked source read
    // "已阻止" twice in the same row.
    renderCenter();

    const rows = screen.getAllByRole("row");
    const blockedRow = rows.find((row) => row.textContent?.includes("不可用的源"));
    expect(blockedRow).toBeTruthy();
    expect(within(blockedRow as HTMLElement).getByText("未适配")).toBeInTheDocument();

    const okRow = rows.find((row) => row.textContent?.includes("可用的源"));
    expect(within(okRow as HTMLElement).getByText("可执行")).toBeInTheDocument();
  });

  it("does not offer an enable switch for a source that cannot run", () => {
    // The switch moved and did nothing, which reads as the app ignoring the click. A dash is the
    // honest answer for "not applicable".
    renderCenter();

    expect(screen.getByRole("switch", { name: "启用 可用的源" })).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "启用 不可用的源" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "启用 待适配的源" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer a connection test for a source that cannot run", () => {
    // A test for a source with no working adapter can only fail, which tells the user nothing.
    // Those rows offer 详情 instead, so the test button count matches the usable sources.
    renderCenter();

    expect(screen.getAllByRole("button", { name: /^测试$/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /详情/ })).toHaveLength(2);
  });

  it("points an unusable source at its details instead of a dead end", () => {
    renderCenter();

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

  it("keeps the list searchable and filterable", () => {
    renderCenter();

    fireEvent.change(screen.getByPlaceholderText("搜索源名称或 API"), {
      target: { value: "不可用" },
    });

    expect(screen.getByText("不可用的源")).toBeInTheDocument();
    expect(screen.queryByText("可用的源")).not.toBeInTheDocument();
  });

  it("reports how many sources the current filter is showing", () => {
    renderCenter();

    expect(screen.getByText(/共 3 个/)).toBeInTheDocument();
  });
});
