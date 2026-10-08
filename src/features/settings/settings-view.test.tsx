import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "@/features/settings/settings-view";

// The settings page is the one place a user goes to answer "what can I change?". Every control on
// it therefore has to change something: a switch that moves and does nothing is worse than no
// switch, because it teaches the user that the app ignores them. These tests pin the line between
// a real setting and a decorative one.
vi.mock("@/lib/tauri", () => ({
  isTauriRuntime: () => true,
}));

function renderSettings(overrides: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const props = {
    theme: "system" as const,
    onThemeChange: vi.fn(),
    autoEpgEnabled: true,
    onAutoEpgEnabledChange: vi.fn(),
    historyCounts: { vod: 2, live: 1 },
    favoriteCounts: { vod: 1, live: 1 },
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

    for (const tab of ["外观", "播放器", "存储", "关于"]) {
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

    for (const tab of ["外观", "播放器", "存储", "关于"]) {
      openTab(tab);
      expect(screen.queryByText("默认跳过片头"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("播放失败时自动切换线路"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("优先选择高清线路"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("允许 HTTP 播放地址"), tab).not.toBeInTheDocument();
    }
  });

  it("does not offer local-network access as a preference", () => {
    // Those switches were inert: no state field backed them, and the addresses they named are
    // refused by a fixed policy rule. The tab that stated the rule as a fact is gone too — a page of
    // settings is not where a fixed boundary belongs — so this asserts the switches never return on
    // any remaining tab.
    renderSettings();

    for (const tab of ["外观", "播放器", "存储", "关于"]) {
      openTab(tab);
      expect(screen.queryByText("允许访问 127.0.0.1"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("允许访问局域网地址"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("允许本机服务依赖"), tab).not.toBeInTheDocument();
    }
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
    renderSettings({
      historyCounts: { vod: 5, live: 2 },
      favoriteCounts: { vod: 3, live: 1 },
      progressCount: 2,
    });
    openTab("存储");

    // Totals are summed from the per-kind counts the dialog lists, so they cannot disagree.
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText(/LOCALAPPDATA/)).not.toBeInTheDocument();
    expect(screen.queryByText("清理请求缓存")).not.toBeInTheDocument();
  });

  it("asks before clearing, in the same dialog the collection pages use", () => {
    // The button no longer clears on press: it opens the checkbox dialog, so the two lists are
    // chosen rather than assumed. A `window.confirm` could not show how many records each kind
    // held, and it was the only surface left asking in a browser prompt.
    const props = renderSettings();
    openTab("存储");

    fireEvent.click(screen.getByRole("button", { name: "清除足迹" }));

    // Nothing is cleared merely by opening the dialog.
    expect(props.onClearHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "影视足迹" })).toHaveAttribute(
      "data-state",
      "checked",
    );

    fireEvent.click(screen.getByRole("button", { name: "清空全部" }));

    expect(props.onClearHistory).toHaveBeenCalledWith("vod");
    expect(props.onClearHistory).toHaveBeenCalledWith("live");
  });

  it("clears favourites through the same dialog, without touching history", () => {
    const props = renderSettings();
    openTab("存储");

    fireEvent.click(screen.getByRole("button", { name: "清除收藏" }));
    fireEvent.click(screen.getByRole("button", { name: "清空全部" }));

    expect(props.onClearFavorites).toHaveBeenCalledWith("vod");
    expect(props.onClearFavorites).toHaveBeenCalledWith("live");
    expect(props.onClearHistory).not.toHaveBeenCalled();
  });

  it("clears only the favourite kind left selected", () => {
    // The two favourite lists are separate store fields; the settings page must be able to clear
    // one without the other, which the previous no-argument call could not express.
    const props = renderSettings();
    openTab("存储");

    fireEvent.click(screen.getByRole("button", { name: "清除收藏" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "影视收藏" }));
    fireEvent.click(
      screen.getByRole("button", { name: "清空电视直播收藏" }),
    );

    expect(props.onClearFavorites).toHaveBeenCalledWith("live");
    expect(props.onClearFavorites).not.toHaveBeenCalledWith("vod");
  });

  it("offers the clear actions in the danger style", () => {
    // Clearing local data is destructive and irreversible; an outline button does not say so.
    renderSettings();
    openTab("存储");

    for (const name of ["清除足迹", "清除收藏"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "data-variant",
        "destructive",
      );
    }
  });

  it("disables a clear action when there is nothing to clear", () => {
    renderSettings({
      historyCounts: { vod: 0, live: 0 },
      favoriteCounts: { vod: 0, live: 0 },
    });
    openTab("存储");

    expect(screen.getByRole("button", { name: "清除足迹" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清除收藏" })).toBeDisabled();
  });

  it("no longer offers any script tooling", () => {
    // The local script archives, the import form and the execution log were all removed along with
    // the script runtime — the feature ran CatVod JS sources from a manually imported file and had
    // never been used. Nothing about scripts belongs on this page now, so the assertions are the
    // absence of every one of those controls rather than the shape of a collapsed card.
    //
    // Checked across every remaining tab rather than on one, because the controls could come back on
    // any of them and the tab this used to check no longer exists.
    renderSettings();

    for (const tab of ["外观", "播放器", "存储", "关于"]) {
      openTab(tab);
      expect(screen.queryByText("本地脚本档案"), tab).not.toBeInTheDocument();
      expect(screen.queryByText("脚本执行诊断"), tab).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "导入本地脚本" }), tab).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "执行本地脚本" }), tab).not.toBeInTheDocument();
      expect(screen.queryByLabelText("运行时脚本"), tab).not.toBeInTheDocument();
      expect(screen.queryByLabelText("脚本执行结果"), tab).not.toBeInTheDocument();
    }
  });

  it("offers the theme as a real choice", () => {
    const props = renderSettings();
    openTab("外观");

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(props.onThemeChange).not.toHaveBeenCalled();
  });

  it("states the execution boundary where a source can be acted on, not as a settings tab", () => {
    // The 安全与网络 tab held three read-only sentences and no control at all: it was named 设置 while
    // offering nothing to set. The facts still exist, but they belong beside the source they describe
    // — where the user can do something about them — rather than on a page of switches.
    renderSettings();

    expect(screen.queryByRole("tab", { name: "安全与网络" })).not.toBeInTheDocument();
    expect(screen.queryByText("执行边界")).not.toBeInTheDocument();
    // The remaining tabs are the ones with something to change.
    for (const tab of ["外观", "播放器", "存储", "关于"]) {
      expect(screen.getByRole("tab", { name: tab }), tab).toBeInTheDocument();
    }
  });

  it("names the page once, with the name the navigation uses", () => {
    // The header carried a "拾影 · 偏好设置" badge next to the heading, which named the product and
    // the page in the same breath as the heading that had already said both.
    //
    // The heading is 设置中心 because that is the label on the rail button the user clicked to get
    // here. It used to read 系统设置, so hovering the icon said one thing and the page said another.
    renderSettings();

    expect(screen.getByRole("heading", { name: "设置中心" })).toBeInTheDocument();
    expect(screen.queryByText("系统设置")).not.toBeInTheDocument();
    expect(screen.queryByText("拾影 · 偏好设置")).not.toBeInTheDocument();
  });

  it("gives every setting row vertical padding, including a lone one", () => {
    // The appearance and player tabs hold a single row. It used `py-3.5 first:pt-0 last:pb-0`, and
    // on a one-row card both rules match at once, so the row got no vertical padding at all and the
    // control was squeezed flat against the card's header and footer — reported as "上下没有任何
    // 高度，被压得很紧". jsdom performs no layout, so this asserts the class contract that produces
    // the height rather than the computed pixels; the rendered result was checked in a browser.
    renderSettings();

    for (const tab of ["外观", "播放器"]) {
      openTab(tab);
      const card = document.querySelector("[data-slot='card']");
      const row = card?.querySelector("[data-slot='card-content'] > div > div");
      expect(row, tab).toBeTruthy();
      expect(row?.className, tab).toContain("py-3.5");
      expect(row?.className, tab).not.toContain("first:pt-0");
      expect(row?.className, tab).not.toContain("last:pb-0");
    }
  });

  it("keeps the row's control from touching the card edge", () => {
    // The padding has to be on the row the control lives in, not only on the card that wraps it.
    renderSettings();
    openTab("播放器");

    const toggle = screen.getByRole("switch", { name: "自动获取节目单" });
    const row = toggle.closest("div.flex.items-start.justify-between");
    expect(row?.className).toContain("py-3.5");
  });

  it("gives every tab an icon", () => {
    // Four bare words take longer to scan than four words with a shape in front of each, which is
    // how the configuration centre's tab row reads.
    renderSettings();

    for (const [label, iconClass] of [
      ["外观", "lucide-palette"],
      ["播放器", "lucide-play"],
      ["存储", "lucide-hard-drive"],
      ["关于", "lucide-info"],
    ] as const) {
      const tab = screen.getByRole("tab", { name: label });
      expect(tab.querySelector(`.${iconClass}`), label).toBeTruthy();
    }
  });

  it("keeps the page from scrolling as a whole, like the configuration centre", () => {
    // The controls have to stay put while a long tab is read. jsdom performs no layout, so this
    // asserts the class contract that produces the behaviour rather than the behaviour itself.
    renderSettings();

    const root = document.querySelector("div.flex.h-full.flex-col.overflow-hidden");
    expect(root).toBeTruthy();
    // The reading column is width-capped and centred, matching the configuration centre.
    expect(root?.querySelector(".max-w-6xl")).toBeTruthy();
  });

  it("labels each clear action with what it clears", () => {
    // Two buttons both reading "清除" give a screen-reader user no way to tell them apart.
    renderSettings();
    openTab("存储");

    expect(screen.getByRole("button", { name: "清除足迹" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除收藏" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除" })).not.toBeInTheDocument();
  });
});
