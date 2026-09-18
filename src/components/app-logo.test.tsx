import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppLogo } from "@/components/app-logo";

describe("AppLogo", () => {
  it("uses the shared branded app icon and accessible product name", () => {
    render(<AppLogo />);

    const logo = screen.getByRole("img", { name: "拾影" });
    expect(logo).toHaveAttribute("src", expect.stringContaining("moseek-app-icon.png"));
    expect(logo).toHaveAttribute("width", "1024");
    expect(logo).toHaveAttribute("height", "1024");
    expect(logo).toHaveAttribute("draggable", "false");
  });

  it("uses the supplied title as both the accessible name and native tooltip", () => {
    render(<AppLogo title="拾影 · 万千影视，一拾即得" />);

    const logo = screen.getByRole("img", { name: "拾影 · 万千影视，一拾即得" });
    expect(logo).toHaveAttribute("title", "拾影 · 万千影视，一拾即得");
  });
});
