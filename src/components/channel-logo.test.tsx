import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChannelLogo } from "@/components/channel-logo";

/**
 * A channel logo whose URL fails must fall back to the channel glyph.
 *
 * The favourites page and 足迹 both rendered a bare `<img>` whose only fallback was an empty
 * string, so a logo that did not load left the browser's broken-image glyph inside the artwork
 * slot — which reads as a defect in Moseek rather than as a picture the source could not serve.
 *
 * Checked against the user's own configuration first: all 1769 logo URLs answer HTTP 200 from a
 * plain client, so the failures are client-side or host-side and intermittent, which is exactly
 * what a fallback is for. jsdom never loads images at all, so firing `error` is the only way to
 * exercise the branch.
 */
describe("ChannelLogo", () => {
  afterEach(cleanup);

  it("shows the channel glyph when the logo fails to load", () => {
    const { container } = render(
      <ChannelLogo src="https://cdn.example/broken.png" name="CCTV1" />,
    );

    const image = container.querySelector("img");
    expect(image).toBeTruthy();

    fireEvent.error(image as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-radio")).toBeTruthy();
  });

  it("shows the glyph straight away when there is no logo at all", () => {
    const { container } = render(<ChannelLogo src="" name="CCTV1" />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-radio")).toBeTruthy();
  });

  it("returns to the image when a working logo replaces a failed one", () => {
    // A channel can be relinked to a different source, so a failure must not be permanent — the
    // fallback would otherwise stick even after a good URL arrived.
    const { container, rerender } = render(
      <ChannelLogo src="https://cdn.example/broken.png" name="CCTV1" />,
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector(".lucide-radio")).toBeTruthy();

    rerender(<ChannelLogo src="https://cdn.example/working.png" name="CCTV1" />);

    expect(container.querySelector("img")).toBeTruthy();
    expect(container.querySelector(".lucide-radio")).toBeNull();
  });

  it("names the channel in the image's alt text", () => {
    // An empty `alt` made every logo decorative, so a screen reader announced nothing at all for
    // the artwork slot.
    render(<ChannelLogo src="https://cdn.example/logo.png" name="CCTV1" />);

    expect(screen.getByAltText("CCTV1 台标")).toBeInTheDocument();
  });
});
