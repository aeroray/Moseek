import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PosterLightbox, PosterZoomButton, nextPanOffset } from "@/components/poster-lightbox";
import { ToastHost } from "@/components/toast-host";
import { ToastProvider } from "@/components/ui/toast";

/**
 * jsdom does not implement `PointerEvent`, so `fireEvent.pointerDown` produces an event whose
 * `clientX` is undefined and the drag gesture cannot be exercised at all. A minimal subclass of
 * `MouseEvent` — which jsdom does implement, and which carries the coordinates — makes the real
 * handlers testable instead of forcing the assertions down to the arithmetic alone.
 */
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
}

const downloadImage = vi.fn();
const resolveLargestPoster = vi.fn();
const isTauriRuntime = vi.fn();

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    downloadImage: (...args: unknown[]) => downloadImage(...args),
    isTauriRuntime: () => isTauriRuntime(),
  };
});

// The resolver is mocked because jsdom never loads an image: the real one times out and
// returns the original, which would make "saves the resolved image" pass no matter what the
// component did with the result.
vi.mock("@/components/poster-candidates", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/poster-candidates")>();
  return {
    ...actual,
    resolveLargestPoster: (...args: unknown[]) => resolveLargestPoster(...args),
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
    resolveLargestPoster.mockReset();
    resolveLargestPoster.mockResolvedValue({
      url: "https://img.example/p.jpg",
      width: 0,
      height: 0,
    });
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

  it("zooms in, out, and resets, reporting the level", () => {
    // The percentage is the only label in the control row: it states the current state, which
    // is the thing a reader needs here.
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    expect(screen.getByText("100%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByText("150%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "缩小" }));
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("disables the zoom controls at their limits", () => {
    // A control that does nothing when pressed is worse than one that says it cannot.
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    expect(screen.getByRole("button", { name: "缩小" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重置" })).toBeDisabled();
    for (let i = 0; i < 12; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "放大" }));
    }
    // The level is asserted, not just the disabled state: an unclamped scale would still
    // disable the button once it passed the limit, so the control alone cannot see it.
    expect(screen.getByText("600%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放大" })).toBeDisabled();
  });

  it("zooms with the wheel", () => {
    // The wheel is registered as a non-passive listener, so a test that fires a plain event
    // still exercises the handler the component actually attached.
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    const viewport = document.querySelector("[data-slot='poster-viewport']");
    expect(viewport).not.toBeNull();
    fireEvent.wheel(viewport as Element, { deltaY: -100 });
    expect(screen.getByText("120%")).toBeInTheDocument();
    fireEvent.wheel(viewport as Element, { deltaY: 100 });
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("clamps the wheel zoom at the same limit as the buttons", () => {
    // The wheel has no disabled state, so it is the only path that can exceed the limit — the
    // buttons stop themselves once they reach it, which hides an unclamped scale entirely.
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    const viewport = document.querySelector("[data-slot='poster-viewport']") as Element;
    for (let i = 0; i < 40; i += 1) {
      fireEvent.wheel(viewport, { deltaY: -100 });
    }
    expect(screen.getByText("600%")).toBeInTheDocument();
  });

  it("clamps the wheel zoom at the minimum too", () => {
    // Zooming below 1x would shrink the poster into a corner of its own frame.
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    const viewport = document.querySelector("[data-slot='poster-viewport']") as Element;
    for (let i = 0; i < 10; i += 1) {
      fireEvent.wheel(viewport, { deltaY: 100 });
    }
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("resets the zoom and the pan together", () => {
    // Returning to 1x has to return the image to the middle too, or "reset" and "zoomed all
    // the way out" leave the picture in two different-looking places.
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    const viewport = document.querySelector("[data-slot='poster-viewport']") as Element;
    fireEvent.pointerDown(viewport, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(viewport, { clientX: 160, clientY: 140, pointerId: 1 });

    const panned = screen.getByRole("img", { name: /海报大图/ }).getAttribute("style") ?? "";
    expect(panned).toMatch(/translate\(60px, 40px\)/);

    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    const reset = screen.getByRole("img", { name: /海报大图/ }).getAttribute("style") ?? "";
    expect(reset).toMatch(/translate\(0px, 0px\)/);
    expect(reset).toMatch(/scale\(1\)/);
  });

  it("clears the pan when zooming back out to fit", () => {
    // The same invariant reached the other way: at 1x there is nowhere to pan, so a leftover
    // offset would leave the image off-centre with no way to explain why.
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    const viewport = document.querySelector("[data-slot='poster-viewport']") as Element;
    fireEvent.pointerDown(viewport, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(viewport, { clientX: 200, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(viewport, { pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: "缩小" }));

    const style = screen.getByRole("img", { name: /海报大图/ }).getAttribute("style") ?? "";
    expect(style).toMatch(/translate\(0px, 0px\)/);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("applies the first move of a drag, not just later ones", () => {
    // The observable contract: the first move after pointer-down must pan.
    //
    // This cannot distinguish a ref from state, because `fireEvent` wraps each event in `act` and
    // flushes the re-render before the next event runs — the exact race that made the state
    // version drop the first move does not occur here. That race was found and confirmed in a
    // real browser; this test guards the behaviour against other regressions.
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    const viewport = document.querySelector("[data-slot='poster-viewport']") as Element;
    fireEvent.pointerDown(viewport, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(viewport, { clientX: 140, clientY: 130, pointerId: 1 });

    const style = screen.getByRole("img", { name: /海报大图/ }).getAttribute("style") ?? "";
    expect(style).toMatch(/translate\(40px, 30px\)/);
  });

  it("stops panning after the pointer is released", () => {
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    const viewport = document.querySelector("[data-slot='poster-viewport']") as Element;
    fireEvent.pointerDown(viewport, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(viewport, { clientX: 140, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    fireEvent.pointerMove(viewport, { clientX: 400, clientY: 400, pointerId: 1 });

    const style = screen.getByRole("img", { name: /海报大图/ }).getAttribute("style") ?? "";
    expect(style).toMatch(/translate\(40px, 30px\)/);
  });

  it("computes the pan offset from the drag distance", () => {
    // The maths is asserted directly: jsdom has no `PointerEvent`, so a synthetic pointer event
    // carries no coordinates and the gesture cannot be driven through the DOM at all.
    expect(
      nextPanOffset({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 160, y: 140 }),
    ).toEqual({ x: 60, y: 40 });
    // A pan already in progress continues from where it was, rather than snapping back.
    expect(
      nextPanOffset({ x: 60, y: 40 }, { x: 200, y: 200 }, { x: 180, y: 250 }),
    ).toEqual({ x: 40, y: 90 });
  });

  it("does not pan while the image fits the frame", () => {
    // Dragging an image that has nowhere to go reads as the viewer being broken. The component
    // refuses to enter the dragging state below 1x, which is what the cursor reflects.
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    const viewport = document.querySelector("[data-slot='poster-viewport']") as Element;
    expect(viewport?.className).toContain("cursor-default");
    // A drag attempt must not move the image. jsdom carries no pointer coordinates, so a
    // gesture that was wrongly accepted would compute an invalid offset rather than a moved
    // one — which is exactly the failure worth catching.
    fireEvent.pointerDown(viewport, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(viewport, { clientX: 200, clientY: 200, pointerId: 1 });
    const resting =
      screen.getByRole("img", { name: /海报大图/ }).getAttribute("style") ?? "";
    expect(resting).toMatch(/translate\(0px, 0px\)/);
    expect(resting).not.toMatch(/NaN/);

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    // Once it can move, the cursor says so.
    expect(
      document.querySelector("[data-slot='poster-viewport']")?.className,
    ).toContain("cursor-grab");
  });

  it("downloads with an icon only, and saves the resolved image", async () => {
    // The resolved address is what is saved: downloading the thumbnail after being shown the
    // large one would be a quiet bait and switch.
    // Set before render, because the resolver runs when the viewer opens.
    resolveLargestPoster.mockResolvedValue({
      url: "https://img.example/p-large.jpg",
      width: 1200,
      height: 1800,
    });
    renderWithHost(
      <PosterLightbox name="测试影片" poster="https://img.example/p.jpg" open onOpenChange={() => {}} />,
    );

    // Wait for the resolution to have been applied, or the download would race it.
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: /海报大图/ }).getAttribute("src"),
      ).toBe("https://img.example/p-large.jpg"),
    );

    const download = screen.getByRole("button", { name: "下载" });
    // No visible word, but still named for assistive technology.
    expect(download).toHaveTextContent("");
    fireEvent.click(download);
    await waitFor(() => expect(downloadImage).toHaveBeenCalled());
    expect(downloadImage).toHaveBeenCalledWith(
      "https://img.example/p-large.jpg",
      "测试影片",
    );
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
