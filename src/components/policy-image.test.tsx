import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyImage } from "@/components/policy-image";
import { cancelMediaRequest, fetchMediaResource } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({ isTauriRuntime: () => true, fetchMediaResource: vi.fn(), cancelMediaRequest: vi.fn(async () => undefined) }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/**
 * The transparent pixel the element shows until real bytes arrive.
 *
 * Its whole purpose is that an `<img>` with no `src` paints a broken-image glyph, so "there is no
 * src" is not a blank state — it is the defect. Tests must therefore assert against this, not
 * against an absent attribute.
 */
const PLACEHOLDER = /^data:image\/gif;base64,R0lGODlhAQABAIAAAAAAAP\/\/\/yH5BAEAAAAALAAAAAABAAEAAAIBRAA7$/;

/** The address the element is actually pointing at, so a test can tell placeholder from artwork. */
const srcOf = (alt: string) => screen.getByAltText(alt).getAttribute("src") ?? "";

describe("artwork behind the desktop network policy", () => {
  it("keeps embedded bitmap images without making a network request", () => {
    render(<PolicyImage src="data:image/png;base64,AQID" alt="本地海报" />);
    expect(screen.getByAltText("本地海报")).toHaveAttribute("src", "data:image/png;base64,AQID");
    expect(fetchMediaResource).not.toHaveBeenCalled();
  });

  it("never lets the browser draw its broken-image state while the bytes are in flight", async () => {
    // **The reported defect.** Every remote poster went through this window, and the element spent
    // it with no `src` — which Chrome paints as a broken-image glyph with the alt text beside it.
    // Measured directly: `src` absent, `src=""` and a failed URL all render identically, and a
    // transparent pixel renders nothing. So the placeholder is the assertion, not an empty
    // attribute: the latter is precisely the bug.
    let resolveFetch!: (value: { bodyBase64: string; contentType: string; url: string }) => void;
    vi.mocked(fetchMediaResource).mockImplementationOnce(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );
    render(<PolicyImage src="https://example.com/poster" alt="海报" />);

    expect(srcOf("海报")).toMatch(PLACEHOLDER);

    await act(async () => {
      resolveFetch({ bodyBase64: "AQID", contentType: "image/png", url: "https://cdn.example/final" });
    });
    // And it is replaced by the real artwork once Rust answers.
    expect(srcOf("海报")).toBe("data:image/png;base64,AQID");
  });

  it("does not report a load for the placeholder", async () => {
    // The placeholder fires `load` as soon as it paints. Forwarding that would tell a caller its
    // artwork had arrived when nothing had, so a poster would drop its loading state immediately
    // and then sit blank until the real bytes landed.
    vi.mocked(fetchMediaResource).mockImplementationOnce(() => new Promise(() => {}));
    const loaded = vi.fn();
    render(<PolicyImage src="https://example.com/poster" alt="海报" onLoad={loaded} />);

    const image = screen.getByAltText("海报");
    act(() => { image.dispatchEvent(new Event("load")); });
    expect(loaded).not.toHaveBeenCalled();
  });

  it("never exposes a rejected remote address to the WebView", async () => {
    vi.mocked(fetchMediaResource).mockRejectedValueOnce(new Error("本机地址已拒绝"));
    const failed = vi.fn();
    render(<PolicyImage src="http://127.0.0.1/private" alt="海报" onError={failed} />);
    // The placeholder is not the rejected address, so the refusal is never handed to the element.
    expect(srcOf("海报")).toMatch(PLACEHOLDER);
    await waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(srcOf("海报")).toMatch(PLACEHOLDER);
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
