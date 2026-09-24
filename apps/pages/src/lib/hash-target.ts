import { useEffect } from "react";
import { useLocation } from "react-router";
import { panelFromHash, scrollToPanel } from "./scroll-panel.js";

/** How long a deep link waits for its row to arrive from a sealed store. */
const WAIT_MS = 5000;

const MARK = "data-hash-target";

const SECTION = "section, .panel, h1, h2, h3, h4";

function mark(target: HTMLElement | null): void {
  for (const node of document.querySelectorAll(`[${MARK}]`)) {
    if (node !== target) node.removeAttribute(MARK);
  }
  target?.setAttribute(MARK, "");
}

/**
 * Land a deep link on its row: `/access?view=grants#share-…` or
 * `/identity?view=people#<id>` scrolls that row into its pane and marks it,
 * so a rail entry or a shared link shows the thing it names instead of the
 * top of the list it sits in.
 *
 * Rows are read from sealed stores after the tab renders, so the row may not
 * exist when the hash changes; the hook waits for it (briefly) rather than
 * giving up on the first frame. Focus is left where it is: a rail entry that
 * previews a row keeps the rail's cursor (AGENTS.md § keyboard access).
 */
export function useHashTarget(): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) {
      mark(null);
      return;
    }
    const land = (): boolean => {
      const target = panelFromHash(hash);
      if (!target) return false;
      scrollToPanel(target);
      // A panel or a heading is where a section starts, not a row to pick
      // out; only a record is marked.
      mark(target.matches(SECTION) ? null : target);
      return true;
    };
    if (land()) return;
    const observer = new MutationObserver(() => {
      if (land()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), WAIT_MS);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [hash]);
}
