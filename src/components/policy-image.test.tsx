import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyImage } from "@/components/policy-image";
import { cancelMediaRequest, fetchMediaResource } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({ isTauriRuntime: () => true, fetchMediaResource: vi.fn(), cancelMediaRequest: vi.fn(async () => undefined) }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("artwork behind the desktop network policy", () => {
  it("keeps embedded bitmap images without making a network request", () => {
    render(<PolicyImage src="data:image/png;base64,AQID" alt="本地海报" />);
    expect(screen.getByAltText("本地海报")).toHaveAttribute("src", "data:image/png;base64,AQID");
    expect(fetchMediaResource).not.toHaveBeenCalled();
  });
  it("never exposes a rejected remote address to the WebView", async () => {
    vi.mocked(fetchMediaResource).mockRejectedValueOnce(new Error("本机地址已拒绝"));
    const failed = vi.fn();
    render(<PolicyImage src="http://127.0.0.1/private" alt="海报" onError={failed} />);
    expect(screen.getByAltText("海报")).not.toHaveAttribute("src");
    await waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(screen.getByAltText("海报")).not.toHaveAttribute("src");
  });

  it("renders only the bytes returned by Rust", async () => {
    vi.mocked(fetchMediaResource).mockResolvedValueOnce({ bodyBase64: "AQID", contentType: "image/png", url: "https://cdn.example/final" });
    render(<PolicyImage src="https://example.com/poster" alt="海报" />);
    await waitFor(() => expect(screen.getByAltText("海报")).toHaveAttribute("src", "data:image/png;base64,AQID"));
  });

  it("waits for visibility before fetching a lazy image", async () => {
    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe() {}
      disconnect() {}
    });
    vi.mocked(fetchMediaResource).mockImplementationOnce(() => new Promise(() => {}));
    const { unmount } = render(<PolicyImage src="https://example.com/logo" alt="台标" loading="lazy" />);
    expect(fetchMediaResource).not.toHaveBeenCalled();
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(fetchMediaResource).toHaveBeenCalledOnce();
    const requestId = vi.mocked(fetchMediaResource).mock.calls[0][3];
    unmount();
    expect(cancelMediaRequest).toHaveBeenCalledWith(requestId);
  });
});
