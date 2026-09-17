import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PosterLightbox, PosterZoomButton } from "@/components/poster-lightbox";
import { ToastHost } from "@/components/toast-host";
import { ToastProvider } from "@/components/ui/toast";

const downloadImage = vi.fn();
const isTauriRuntime = vi.fn();

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    downloadImage: (...args: unknown[]) => downloadImage(...args),
    isTauriRuntime: () => isTauriRuntime(),
  };
});

function renderWithHost(node: React.ReactNode) {
  // Both wrappers are needed: `ToastHost` owns the queue the component pushes to, and Radix's
  // provider owns the portal the toast renders into. Without the provider the push succeeds but
  // nothing appears, which looks exactly like the feature being broken.
  return render(
    <ToastProvider>
      <ToastHost>{node}</ToastHost>
    </ToastProvider>,
  );
}

describe("poster viewer", () => {
  afterEach(cleanup);

  beforeEach(() => {
    downloadImage.mockReset();
    isTauriRuntime.mockReset();
    isTauriRuntime.mockReturnValue(true);
    downloadImage.mockResolvedValue({
      path: "D:\\海报\\测试影片.jpg",
      bytes: 2048,
    });
  });

  it("opens the large view from the card's own button", () => {
    renderWithHost(
      <PosterZoomButton name="测试影片" poster="https://img.example/p.jpg" />,
    );

    // The trigger names the work, so the action is unambiguous out of context.
    const trigger = screen.getByRole("button", { name: /查看 测试影片 的海报大图/ });
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /测试影片 海报大图/ }),
    ).toHaveAttribute("src", "https://img.example/p.jpg");
  });

  it("offers no viewer when the work has no poster", () => {
    // A button that opens an empty dialog is worse than no button.
    const { container } = renderWithHost(
      <PosterZoomButton name="测试影片" poster="" />,
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("saves through the native picker and reports where it went", async () => {
    renderWithHost(
      <PosterLightbox
        name="测试影片"
        poster="https://img.example/p.jpg"
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /下载/ }));

    await waitFor(() => {
      expect(downloadImage).toHaveBeenCalledWith(
        "https://img.example/p.jpg",
        "测试影片",
      );
    });
    // The path is the useful part of the confirmation: the user chose it and may want to find it.
    expect(await screen.findByText(/测试影片\.jpg/)).toBeInTheDocument();
  });

  it("stays silent when the user dismisses the save dialog", async () => {
    // A cancelled dialog is an ordinary outcome, not a failure worth reporting.
    downloadImage.mockResolvedValue(null);
    renderWithHost(
      <PosterLightbox
        name="测试影片"
        poster="https://img.example/p.jpg"
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /下载/ }));

    await waitFor(() => expect(downloadImage).toHaveBeenCalled());
    expect(screen.queryByText(/已保存海报/)).toBeNull();
    expect(screen.queryByText(/保存失败/)).toBeNull();
  });

  it("reports a real save failure", async () => {
    downloadImage.mockRejectedValue(new Error("写入文件失败：磁盘已满"));
    renderWithHost(
      <PosterLightbox
        name="测试影片"
        poster="https://img.example/p.jpg"
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /下载/ }));

    expect(await screen.findByText(/保存失败/)).toBeInTheDocument();
    expect(screen.getByText(/磁盘已满/)).toBeInTheDocument();
  });

  it("explains that the browser preview cannot save", async () => {
    // Without this the button would appear to do nothing at all in a preview build.
    isTauriRuntime.mockReturnValue(false);
    downloadImage.mockResolvedValue(null);
    renderWithHost(
      <PosterLightbox
        name="测试影片"
        poster="https://img.example/p.jpg"
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /下载/ }));

    expect(await screen.findByText(/浏览器预览无法保存/)).toBeInTheDocument();
  });

  it("renders without a toast host rather than failing", async () => {
    // The viewer is reachable from any card, so a missing host must not break the page.
    render(
      <PosterLightbox
        name="测试影片"
        poster="https://img.example/p.jpg"
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /下载/ }));
    await waitFor(() => expect(downloadImage).toHaveBeenCalled());
  });

  it("says so when the poster itself cannot load", async () => {
    renderWithHost(
      <PosterLightbox
        name="测试影片"
        poster="https://img.example/broken.jpg"
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: /海报大图/ }));

    expect(await screen.findByText("这张海报无法加载")).toBeInTheDocument();
  });
});
