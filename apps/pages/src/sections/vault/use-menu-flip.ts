/**
 * A row's `⋯` menu hangs below the row. On the bottom row of a
 * fully-expanded tree it would run past the scrollport's bottom
 * edge and its border would be clipped by it — so it seats above
 * the row instead, but only when it fits there too. Measured in a
 * layout effect, before paint; a browser whose rectangles are all
 * zero (jsdom) reads "fits below" and leaves it where it was.
 *
 * The menu's node arrives through `listRef`, a stable callback
 * ref the owning tree hands to its menu, so the flip is
 * recomputed only when the open row changes.
 */
import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type MenuFlip = {
  listRef: (node: HTMLDivElement | null) => void;
  menuAbove: boolean;
};

export function useMenuFlip(
  menuFor: string | null,
  portRef: RefObject<HTMLDivElement | null>,
): MenuFlip {
  const [menuAbove, setMenuAbove] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node;
  }, []);

  useLayoutEffect(() => {
    const port = portRef.current;
    const menu = menuRef.current;
    if (!menuFor || !port || !menu) {
      setMenuAbove(false);
      return;
    }
    const row = menu.closest<HTMLElement>(".vtree__row");
    if (!row) {
      setMenuAbove(false);
      return;
    }
    const portBox = port.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    const hangsPastBottom = menuBox.bottom > portBox.bottom;
    const fitsAbove = rowBox.top - menuBox.height >= portBox.top;
    setMenuAbove(hangsPastBottom && fitsAbove);
  }, [menuFor, portRef]);

  return { listRef, menuAbove };
}
