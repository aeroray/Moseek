import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigVisualEditor } from "@/features/config/config-visual-editor";
import type { SourceRecord } from "@/types/moseek";

/**
 * The visual editor's required/optional labelling.
 *
 * This exists because the user asked to be able to tell at a glance which fields the app cannot run
 * without, and the editor previously answered that with a bare red `*` — which tells you nothing
 * unless you already know the convention, and says nothing at all about the other fields.
 *
 * The distinction is also load-bearing rather than decorative: `key` and `name` were labelled
 * required, but the parser falls back to `id` and then numbers and names the entry itself, so a
 * source without them still loads and still plays. Calling those 必需 would tell the user to keep a
 * field that changes nothing.
 */

const CONFIG = JSON.stringify({
  sites: [
    { key: "a", name: "甲源", api: "https://a.example/api", jar: "https://a/x.jar" },
  ],
  lives: [{ name: "甲直播", url: "https://live.example/list.m3u" }],
  parses: [{ name: "甲解析", url: "https://parse.example/?url=" }],
  wallpaper: "https://wall.example/1.jpg",
});

function source(): SourceRecord {
  return {
    key: "a",
    name: "甲源",
    sourceType: "cms",
    api: "https://a.example/api",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "普通 HTTP API。",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
  };
}

function renderEditor() {
  render(
    <ConfigVisualEditor value={CONFIG} onChange={vi.fn()} sources={[source()]} />,
  );
  // Fields live inside an entry, and entries start collapsed — a 340-entry list of always-open forms
  // would be a wall. Open the first one so the fields under test are on screen.
  fireEvent.click(screen.getByRole("button", { name: "编辑 甲源" }));
}

/** The row for one field, found by its label text so the badge is read from the right place. */
function fieldRow(name: string) {
  const label = screen.getByText(name, { selector: "span.font-mono" });
  return label.closest("label") as HTMLElement;
}

describe("required and optional field labels", () => {
  afterEach(cleanup);

  it("survives valid to invalid to valid text without changing hook order", () => {
    const { rerender } = render(<ConfigVisualEditor value={CONFIG} onChange={vi.fn()} sources={[]} />);
    rerender(<ConfigVisualEditor value="{" onChange={vi.fn()} sources={[]} />);
    expect(screen.getByText("无法以可视化方式打开")).toBeInTheDocument();
    rerender(<ConfigVisualEditor value={CONFIG} onChange={vi.fn()} sources={[]} />);
    expect(screen.getByRole("button", { name: "编辑 甲源" })).toBeInTheDocument();
  });

  it("labels the address field 必需", () => {
    renderEditor();

    expect(within(fieldRow("api")).getByText("必需")).toBeInTheDocument();
  });

  it("labels key and name 可选, because the parser supplies fallbacks", () => {
    // The correction that matters: these were marked required, and a source without them still
    // works — the parser falls back to `id`, then numbers the entry, and names it 未命名源 N.
    renderEditor();

    expect(within(fieldRow("key")).getByText("可选")).toBeInTheDocument();
    expect(within(fieldRow("name")).getByText("可选")).toBeInTheDocument();
  });

  it("labels every offered field one way or the other, so nothing is left ambiguous", () => {
    // A bare `*` marked the required fields and left the rest unmarked, which is indistinguishable
    // from "we did not think about this one".
    renderEditor();

    for (const name of ["key", "name", "api", "type", "jar"]) {
      const row = fieldRow(name);
      expect(
        within(row).queryByText("必需") ?? within(row).queryByText("可选"),
      ).not.toBeNull();
    }
  });

  it("marks the 其他设置 block as 非必需", () => {
    // These are TVBox client settings. Moseek does not read them and does not export them, so a user
    // deciding what to delete should not have to guess whether removing them breaks anything.
    renderEditor();

    expect(screen.getByText("非必需")).toBeInTheDocument();
  });

  it("marks each configuration section 必需", () => {
    // 影视源 / 直播源 / 解析服务 each feed a feature; a section missing means that feature has no
    // data, which is worth stating rather than leaving to be discovered.
    renderEditor();

    // One per section, and there are three sections.
    expect(screen.getAllByText("必需").length).toBeGreaterThanOrEqual(3);
  });
});
