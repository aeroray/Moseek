import { useEffect, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ViewPane, useViewActive } from "@/components/view-pane";
import { useAppStore } from "@/stores/app-store";

/**
 * The keep-alive rule, tested through the store the real navigation uses.
 *
 * The defect these guard: the views were rendered conditionally, so navigating away unmounted them
 * and threw away everything they held — the library's search term and results, the live workspace's
 * channel, the page number. Coming back was then indistinguishable from a first visit, which is what
 * the user reported as "it reloads like the home page".
 */
function Probe({ label }: { label: string }) {
  const active = useViewActive();
  return (
    <div data-testid={label} data-active={active ? "yes" : "no"}>
      {label}
    </div>
  );
}

describe("ViewPane", () => {
  afterEach(cleanup);

  it("keeps an inactive view in the document rather than unmounting it", () => {
    // The whole point. `display: none` would be wrong for the same reason unmounting is: the source
    // table's virtualiser measures its viewport, and a zero-height one makes it mount every row.
    const { rerender } = render(
      <ViewPane active>
        <Probe label="library" />
      </ViewPane>,
    );
    expect(screen.getByTestId("library")).toBeInTheDocument();

    rerender(
      <ViewPane active={false}>
        <Probe label="library" />
      </ViewPane>,
    );

    // Still there — and hidden without losing its box.
    const pane = screen.getByTestId("library").parentElement;
    expect(screen.getByTestId("library")).toBeInTheDocument();
    expect(pane?.className).toContain("invisible");
    expect(pane?.className).not.toContain("hidden");
  });

  it("takes the hidden view out of the tab order and the accessibility tree", () => {
    // A keyboard user must not be able to tab into a view they cannot see.
    const { rerender } = render(
      <ViewPane active>
        <Probe label="library" />
      </ViewPane>,
    );
    const pane = () => screen.getByTestId("library").parentElement;
    expect(pane()?.hasAttribute("inert")).toBe(false);
    expect(pane()?.getAttribute("aria-hidden")).toBeNull();

    rerender(
      <ViewPane active={false}>
        <Probe label="library" />
      </ViewPane>,
    );
    expect(pane()?.hasAttribute("inert")).toBe(true);
    expect(pane()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("gates the whole subtree with opacity, which no descendant can override", () => {
    // The reported "the previous page's button is still disappearing while the new page has already
    // appeared". `invisible` alone is not enough: `visibility` is inheritable but *overridable*, and
    // every `Button` here carries Tailwind's `transition-all`, whose `transition-property: all`
    // includes `visibility` — an interpolable property whose every intermediate value computes to
    // `visible`. So a button inside an already-hidden pane kept reporting `visibility: visible` and
    // was genuinely painted. Measured frame by frame on a real switch before this: the pane was
    // hidden while a button from it (`浏览影视库`) was still painted.
    //
    // `opacity` is applied to the subtree as a group and is not inherited, so nothing inside can
    // override it back onto the screen.
    const { rerender } = render(
      <ViewPane active>
        <Probe label="library" />
      </ViewPane>,
    );
    const pane = () => screen.getByTestId("library").parentElement;
    expect(pane()?.className).toContain("transition-none");

    rerender(
      <ViewPane active={false}>
        <Probe label="library" />
      </ViewPane>,
    );
    expect(pane()?.className).toContain("opacity-0");
    expect(pane()?.className).toContain("invisible");
    // Still no layout removal: the virtualiser has to be able to measure this box.
    expect(pane()?.className).not.toContain("hidden");
  });

  it("tells its subtree whether it is the visible one", () => {
    const { rerender } = render(
      <ViewPane active>
        <Probe label="library" />
      </ViewPane>,
    );
    expect(screen.getByTestId("library").dataset.active).toBe("yes");

    rerender(
      <ViewPane active={false}>
        <Probe label="library" />
      </ViewPane>,
    );
    expect(screen.getByTestId("library").dataset.active).toBe("no");
  });

  it("reports active by default when there is no pane", () => {
    // Components are rendered outside a pane in several tests and in the favourites page; they must
    // keep behaving as they did before this existed.
    render(<Probe label="loose" />);
    expect(screen.getByTestId("loose").dataset.active).toBe("yes");
  });
});

describe("App view switching", () => {
  beforeEach(() => {
    useAppStore.setState({ activeView: "browse" });
  });

  afterEach(cleanup);

  it("keeps a visited view mounted when the user navigates away and back", async () => {
    // Exercised through the store, because that is what the nav rail and `navigate` both drive.
    // A minimal stand-in for `App`'s own render, so this stays about the switching rule.
    const views: Array<"browse" | "live"> = ["browse", "live"];
    function Harness() {
      const activeView = useAppStore((state) => state.activeView);
      const [visited, setVisited] = useState<Array<"browse" | "live">>(["browse"]);
      useEffect(() => {
        if (activeView !== "browse" && activeView !== "live") return;
        setVisited((current) =>
          current.includes(activeView) ? current : [...current, activeView],
        );
      }, [activeView]);
      return (
        <>
          {views
            .filter((view) => visited.includes(view))
            .map((view) => (
              <ViewPane key={view} active={activeView === view}>
                <Probe label={view} />
              </ViewPane>
            ))}
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("browse")).toBeInTheDocument();
    expect(screen.queryByTestId("live")).toBeNull();

    // Go to the live workspace: the library is hidden, not destroyed.
    useAppStore.setState({ activeView: "live" });
    await waitFor(() => expect(screen.getByTestId("live")).toBeInTheDocument());
    expect(screen.getByTestId("browse")).toBeInTheDocument();
    expect(screen.getByTestId("browse").dataset.active).toBe("no");
    expect(screen.getByTestId("live").dataset.active).toBe("yes");

    // Come back: still the same instance, now visible again.
    useAppStore.setState({ activeView: "browse" });
    await waitFor(() =>
      expect(screen.getByTestId("browse").dataset.active).toBe("yes"),
    );
    expect(screen.getByTestId("live").dataset.active).toBe("no");
  });

  it("does not mount a view that has never been opened", () => {
    // First visits must still load normally — mounting all six at launch would fire every view's
    // initial requests at startup.
    const visited = ["browse"];
    render(
      <>
        {visited.map((view) => (
          <ViewPane key={view} active>
            <Probe label={view} />
          </ViewPane>
        ))}
      </>,
    );

    expect(screen.getByTestId("browse")).toBeInTheDocument();
    expect(screen.queryByTestId("live")).toBeNull();
    expect(screen.queryByTestId("config")).toBeNull();
  });
});
