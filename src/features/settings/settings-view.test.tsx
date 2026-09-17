import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "@/features/settings/settings-view";

// The settings page is the one place a user goes to answer "what can I change?". Every control on
// it therefore has to change something: a switch that moves and does nothing is worse than no
// switch, because it teaches the user that the app ignores them. These tests pin the line between
// a real setting and a decorative one.
vi.mock("@/lib/tauri", () => ({
  isTauriRuntime: () => true,
  listScriptArchives: vi.fn(async () => []),
  listScriptExecutionLogs: vi.fn(async () => []),
  saveScriptArchive: vi.fn(),
  setScriptArchiveEnabled: vi.fn(),
  deleteScriptArchive: vi.fn(),
  purgeScriptArchive: vi.fn(),
  restoreScriptArchive: vi.fn(),
  executeScriptArchive: vi.fn(),
}));

function renderSettings(overrides: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const props = {
    theme: "system" as const,
    onThemeChange: vi.fn(),
    autoEpgEnabled: true,
    onAutoEpgEnabledChange: vi.fn(),
    historyCount: 3,
    favoriteCount: 2,
    progressCount: 1,
    onClearHistory: vi.fn(),
    onClearFavorites: vi.fn(),
    ...overrides,
  };
  render(<SettingsView {...props} />);
  return props;
}

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("settings page", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("shows only settings that do something", () => {
    // 界面状态 listed the font, the animation duration and the zoom as if they were choices.
    // They are fixed properties of the design, not preferences, so the card is gone.
    // Checked across every tab, so the assertion cannot be satisfied by the card merely moving.
    renderSettings();

    for (const tab of ["外观", "播放器", "安全与网络", "存储"]) {
      openTab(tab);
      expect(screen.queryByText("界面状态"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("界面字体"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("动画时长"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("缩放比例"), tab).not.toBeInTheDocument();
    }
  });

  it("does not offer inert player placeholders on any tab", () => {
    // These switches had no backing state either; they were pure decoration.
    renderSettings();

    for (const tab of ["外观", "播放器", "安全与网络", "存储"]) {
      openTab(tab);
      expect(screen.queryByText("默认跳过片头"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("播放失败时自动切换线路"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("优先选择高清线路"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("允许 HTTP 播放地址"), tab).not.toBeInTheDocument();
    }
  });

  it("does not offer local-network access as a preference", () => {
    // Those switches were inert: no state field backed them, and the addresses they named are
    // refused by a fixed policy rule. The rule is stated as a fact instead of offered as a
    // toggle that cannot be honoured.
    renderSettings();
    openTab("安全与网络");

    expect(screen.queryByText("允许访问 127.0.0.1")).not.toBeInTheDocument();
    expect(screen.queryByText("允许访问局域网地址")).not.toBeInTheDocument();
    expect(screen.queryByText("允许本机服务依赖")).not.toBeInTheDocument();
    expect(screen.getByText("本机与局域网地址默认拒绝访问")).toBeInTheDocument();
  });

  it("keeps the one player preference that is actually persisted", () => {
    renderSettings();
    openTab("播放器");

    const toggle = screen.getByRole("switch", { name: "自动获取节目单" });
    expect(toggle).toBeInTheDocument();
    // The placeholder switches from this tab are gone.
    expect(screen.queryByText("默认跳过片头")).not.toBeInTheDocument();
    expect(screen.queryByText("优先选择高清线路")).not.toBeInTheDocument();
  });

  it("toggles the programme-guide preference for real", () => {
    const props = renderSettings();
    openTab("播放器");

    fireEvent.click(screen.getByRole("switch", { name: "自动获取节目单" }));

    expect(props.onAutoEpgEnabledChange).toHaveBeenCalledWith(false);
  });

  it("reports real local data instead of invented paths", () => {
    // The storage tab used to print two directory paths that nothing wrote to, and a "clear
    // cache" button with no handler at all.
    renderSettings({ historyCount: 7, favoriteCount: 4, progressCount: 2 });
    openTab("存储");

    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText(/LOCALAPPDATA/)).not.toBeInTheDocument();
    expect(screen.queryByText("清理请求缓存")).not.toBeInTheDocument();
  });

  it("clears history through the store rather than pretending to", () => {
    const props = renderSettings();
    openTab("存储");

    fireEvent.click(screen.getByRole("button", { name: "清除足迹" }));

    expect(props.onClearHistory).toHaveBeenCalledTimes(1);
  });

  it("clears favourites separately from history", () => {
    // The two lists are independent; clearing one must not silently take the other.
    const props = renderSettings();
    openTab("存储");

    fireEvent.click(screen.getByRole("button", { name: "清除收藏" }));

    expect(props.onClearFavorites).toHaveBeenCalledTimes(1);
    expect(props.onClearHistory).not.toHaveBeenCalled();
  });

  it("disables a clear action when there is nothing to clear", () => {
    renderSettings({ historyCount: 0, favoriteCount: 0 });
    openTab("存储");

    expect(screen.getByRole("button", { name: "清除足迹" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清除收藏" })).toBeDisabled();
  });

  it("keeps the script tooling out of the way until it is asked for", () => {
    // Importing a local CatVod script and supplying an entry function, an HTTP allowlist and a
    // module map is not something an ordinary user does. The card explains what it is for and
    // stays collapsed, so the page does not read as though it expects that work.
    renderSettings();
    openTab("安全与网络");

    expect(screen.queryByRole("button", { name: "导入本地脚本" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开" }));

    expect(screen.getByRole("button", { name: "导入本地脚本" })).toBeInTheDocument();
  });

  it("no longer offers a free-form script console", () => {
    // The runtime playground asked for a script, a JSON input, an allowlist and a module map.
    // It was a developer tool in the settings page; the per-archive check covers the real need.
    renderSettings();
    openTab("安全与网络");
    fireEvent.click(screen.getByRole("button", { name: "展开" }));

    expect(screen.queryByLabelText("运行时脚本")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("脚本执行结果")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "执行本地脚本" })).not.toBeInTheDocument();
  });

  it("still exposes the execution log for scripts that do run", () => {
    renderSettings();
    openTab("安全与网络");

    expect(screen.getByText("脚本执行诊断")).toBeInTheDocument();
  });

  it("offers the theme as a real choice", () => {
    const props = renderSettings();
    openTab("外观");

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(props.onThemeChange).not.toHaveBeenCalled();
  });

  it("states the execution boundary as fixed rules", () => {
    renderSettings();
    openTab("安全与网络");

    const boundary = screen.getByText("执行边界").closest("[data-slot='card']");
    expect(boundary).toBeTruthy();
    expect(
      within(boundary as HTMLElement).getByText(/远程 JavaScript、JAR 和 spider 默认阻止/),
    ).toBeInTheDocument();
  });
});
