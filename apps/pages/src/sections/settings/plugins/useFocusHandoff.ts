/**
 * A key that can leave the tile while a person is on it (a switch the daemon's
 * answer took away, a pairing that was forgotten) hands focus to a stable
 * element of the tile as React detaches it, so focus never falls to the page
 * (AGENTS.md, keyboard access).
 */

import { type RefObject, useCallback, useRef } from "react";

export function useFocusHandoff<Node extends HTMLElement>(
  target: RefObject<HTMLElement | null>,
) {
  const held = useRef<Node | null>(null);
  return useCallback(
    (node: Node | null) => {
      const leaving = held.current;
      held.current = node;
      if (
        node === null &&
        leaving !== null &&
        document.activeElement === leaving
      )
        target.current?.focus();
    },
    [target],
  );
}
