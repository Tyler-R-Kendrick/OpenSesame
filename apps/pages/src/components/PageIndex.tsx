import { Link } from "react-router";
import type { PageTreeLeaf } from "../lib/page-to-tree.js";

/**
 * "On this page", for a phone.
 *
 * A desktop reaches a long page's panels from the rail, which lists them as
 * the tab's children. A phone has no rail: the section drawer names sections
 * and nothing else (DESIGN.md § Navigation), so Security — four thousand
 * pixels of panels on a 390px screen — could only be scrolled through, and a
 * panel the rail links to by name had no road to it at all. This is the same
 * list the rail draws, from the same page tree, as a strip under the tabs.
 * Above 900px the rail is on screen and the strip is not drawn.
 */
export function PageIndex({
  entries,
  label = "On this page",
}: {
  entries: readonly PageTreeLeaf[];
  label?: string;
}) {
  // Only entries that land on a panel of this page: a list of rows that all
  // open the same page (Vaults' vaults) is not an index of it.
  const anchors = entries.filter((entry) => entry.href.includes("#"));
  if (anchors.length < 2) return null;
  return (
    <nav className="page-index" aria-label={label}>
      {anchors.map((entry) => (
        <Link
          key={entry.id}
          to={entry.href}
          className="page-index__link"
          onClick={(event) => {
            // A new-tab or new-window click leaves this page where it is.
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            // The link may already be the current hash, which navigates
            // nowhere; the reader still asked to be taken there.
            const id = entry.href.slice(entry.href.indexOf("#") + 1);
            const target = document.getElementById(id);
            if (target) scrollToPanel(target);
          }}
        >
          {entry.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Bring a panel to the top of the pane that scrolls it — vertically, and
 * nothing else. `scrollIntoView` also scrolls every ancestor sideways to fit
 * the element, which is how one over-wide row dragged a whole section off
 * the side of a phone (DESIGN.md § Touch).
 */
function scrollToPanel(target: HTMLElement): void {
  for (let node = target.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      node.scrollTop +=
        target.getBoundingClientRect().top - node.getBoundingClientRect().top;
      return;
    }
  }
  window.scrollBy(0, target.getBoundingClientRect().top);
}
