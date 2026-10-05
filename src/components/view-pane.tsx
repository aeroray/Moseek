import { createContext, useContext, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Whether the view this subtree belongs to is the one currently on screen.
 *
 * Exists so that a component deep in a view — a media player, most importantly — can react to the
 * view being put away without every view having to thread an `isActive` prop down to it. The default
 * is `true`, so a component rendered outside any pane behaves exactly as it did before.
 */
const ViewActiveContext = createContext(true);

export function useViewActive() {
  return useContext(ViewActiveContext);
}

/**
 * One workspace view, kept alive while the user is somewhere else.
 *
 * **Why this exists.** The views were rendered conditionally (`{activeView === "browse" && …}`), so
 * navigating away unmounted them and destroyed everything they held in local state: the search term
 * and its results, the page number, the selected channel, the scroll position. Coming back was
 * therefore indistinguishable from arriving for the first time — the reported "it reloads like the
 * home page". Mounting every visited view once and hiding the inactive ones keeps that state, which
 * is what a desktop workspace is expected to do.
 *
 * **Why hidden rather than unmounted.** Unmounting is the bug. `display: none` would also be wrong:
 * it removes the element's box, and the source table's virtualiser decides how many rows to mount by
 * measuring its viewport — measured in this project, a `display: none` container reports
 * `clientHeight` 0, which the virtualiser correctly reads as "no layout engine" and answers by
 * mounting **every** row (the 270 ms stall its windowing exists to prevent). `visibility: hidden`
 * keeps the box, so the measurement stays truthful while nothing is painted or clickable. `inert`
 * additionally takes the hidden subtree out of the tab order and away from the accessibility tree,
 * so a keyboard user cannot tab into a view they cannot see.
 *
 * The first mount is still deferred to the first visit — see `App`, which only renders a pane once
 * its view has been opened. Arriving for the first time loads normally; arriving again does not.
 */
export function ViewPane({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ViewActiveContext.Provider value={active}>
      <div
        // `absolute inset-0` so every pane occupies the same area of the workspace and the inactive
        // ones are stacked behind the active one rather than pushing it around.
        //
        // `invisible` (visibility: hidden) keeps the box so the virtualiser can still measure it.
        //
        // **`opacity-0` is the part that actually guarantees nothing shows, and it is load-bearing.**
        // Every `Button` in these views carries Tailwind's `transition-all`, i.e.
        // `transition-property: all` with a 150ms duration — and `visibility` is an *interpolable*
        // property whose every intermediate value computes to `visible`. So after a switch the
        // outgoing pane's buttons kept computing `visible` inside an already-`hidden` pane, and since
        // `visibility` is inheritable but *overridable*, a descendant still computing `visible` is
        // genuinely painted. Measured frame by frame on a real switch: the pane was `hidden` while a
        // button from it (`浏览影视库`) still reported `visibility: visible` and was painted — exactly
        // the reported "the previous page's button is still disappearing while the new page has
        // already appeared".
        //
        // `opacity` is the fix rather than suppressing the descendants' transitions: it is applied to
        // the element's whole subtree as a group and is not inherited, so no child can override it,
        // and it does not disturb layout — so the box, the scroll position and the virtualiser's
        // measurement all survive. (`content-visibility: hidden` would also stop the painting, but it
        // skips laying out the contents, which collapses the scroll container and would throw away
        // the scroll position this whole component exists to preserve.) `transition-none` keeps the
        // pane's own change on the frame it happens.
        className={cn(
          "absolute inset-0 transition-none",
          !active && "invisible opacity-0",
        )}
        aria-hidden={active ? undefined : true}
        inert={active ? undefined : true}
      >
        {children}
      </div>
    </ViewActiveContext.Provider>
  );
}
