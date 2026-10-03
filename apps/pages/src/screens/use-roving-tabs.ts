/**
 * A tablist's roving tab stop: the selected tab is the one
 * Tab reaches, and the arrow keys move through the tabs the
 * way a tablist does — Left/Right by one, Home/End to the
 * ends — selecting as they go, so a keyboard reader never
 * has to leave the tablist to change the selected tab.
 */
import { type KeyboardEvent, useRef } from "react";

export function useRovingTabs({
  count,
  index,
  select,
}: {
  count: number;
  index: number;
  select: (index: number) => void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const moveTab = (event: KeyboardEvent, at: number) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const edge =
      event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
    if (step === 0 && edge === null) return;
    event.preventDefault();
    const next = edge ?? (at + step + count) % count;
    if (next < 0 || next >= count) return;
    select(next);
    tabRefs.current[next]?.focus();
  };

  /** The props a tab wears: its stop, its tab, its keys. */
  const tabProps = (at: number) => ({
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => moveTab(event, at),
    ref: (node: HTMLButtonElement | null) => {
      tabRefs.current[at] = node;
    },
    tabIndex: at === index ? 0 : -1,
  });

  return { tabProps };
}
