import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/components/app-shell";

/**
 * The window buttons are mocked at the Tauri boundary rather than driven through the real one.
 *
 * `getCurrentWindow()` reaches into `__TAURI_INTERNALS__` for a `currentWindow` handle, which jsdom
 * cannot provide — and faking enough of it to satisfy the real module would test the fake. What is
 * under test here is this project's own decision: whether the buttons are drawn at all, and what
 * they are called. `isTauriRuntime` is what that decision turns on, so the mock sits one level down.
 */
const windowApi = {
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onResized: vi.fn(() => Promise.resolve(() => {})),
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));

describe("the self-drawn window bar", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  function renderShell() {
    return render(
      <AppShell activeView="browse" onNavigate={() => {}}>
        <div>内容</div>
      </AppShell>,
    );
  }

  it("carries no text, so the product name is not repeated a third time", () => {
    // The native title bar showed the English name, the Chinese name and the slogan above a window
    // that already showed all three. The bar that replaces it must not restate any of them: the mark
    // identifies the app, and the slogan survives as its tooltip.
    renderShell();

    const bar = document.querySelector("[data-tauri-drag-region]") as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.textContent?.trim()).toBe("");
    expect(screen.queryByText(/Moseek/)).not.toBeInTheDocument();
    // The slogan is present as a tooltip, not as visible text.
    expect(screen.getByRole("img", { name: "拾影 · 万千影视，一拾即得" })).toBeInTheDocument();
    expect(screen.queryByText("万千影视，一拾即得")).not.toBeInTheDocument();
  });

  it("renders no window buttons outside the desktop runtime", () => {
    // jsdom is the browser-preview case: there is no window to minimise. Drawing the buttons anyway
    // would offer controls that cannot work, which is the rule this project applies to every
    // surface — a control that does nothing teaches the user the app ignores them.
    renderShell();

    expect(screen.queryByRole("button", { name: "最小化" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "最大化" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
  });

  it("renders the window buttons in the desktop runtime, and they control the window", () => {
    // The real runtime is what the installer ships, so the buttons must exist and must be wired.
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    renderShell();

    screen.getByRole("button", { name: "最小化" }).click();
    expect(windowApi.minimize).toHaveBeenCalled();

    screen.getByRole("button", { name: "最大化" }).click();
    expect(windowApi.toggleMaximize).toHaveBeenCalled();

    screen.getByRole("button", { name: "关闭" }).click();
    expect(windowApi.close).toHaveBeenCalled();
  });

  it("stacks the window bar above the workspace rather than beside it", () => {
    // **The defect this exists for.** The bar was added inside a container that was still `flex-row`,
    // so it became a narrow column on the left and the window buttons appeared in the top-left corner
    // of the window instead of the top-right. jsdom performs no layout, so the class contract is what
    // is asserted — and it is the contract that was wrong.
    renderShell();

    const shell = document.querySelector("div.flex.h-screen") as HTMLElement;
    expect(shell).toBeTruthy();
    expect(shell.className).toContain("flex-col");

    // The bar must be the first child, so it renders above the rail and the work area.
    const bar = document.querySelector("[data-tauri-drag-region]") as HTMLElement;
    expect(shell.firstElementChild).toBe(bar);
  });

  it("keeps the drag region on the bar, so the window can still be moved", () => {
    // Without `data-tauri-drag-region` a frameless window cannot be dragged at all, and the user has
    // no way to move it — the native bar was the thing providing that before.
    renderShell();

    const bar = document.querySelector("[data-tauri-drag-region]") as HTMLElement;
    expect(bar).toBeTruthy();
    // The mark sits inside the drag region, so dragging by the logo also moves the window.
    expect(bar.querySelector("img")).toBeTruthy();
  });
});
