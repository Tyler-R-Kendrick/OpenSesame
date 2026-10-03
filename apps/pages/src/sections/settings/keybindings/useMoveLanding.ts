import { type RefObject, useEffect, useState } from "react";

export type MoveLanding = { index: number; dir: "up" | "down" };

/**
 * Steps are positional, so after a step moves the focused button is left at
 * the old position holding another step. Follow the step instead: focus the
 * same direction's key at its new position, or the other one where that
 * direction has run out (the first step cannot go up). Only while focus is
 * still in the list — never one the person carried elsewhere.
 */
export function useMoveLanding(list: RefObject<HTMLElement | null>) {
  const [landing, setLanding] = useState<MoveLanding | null>(null);
  useEffect(() => {
    if (landing === null) return;
    const active = document.activeElement;
    const idle =
      active === null ||
      active === document.body ||
      list.current?.contains(active);
    if (idle) {
      const step = list.current?.querySelector(
        `[data-step="${landing.index}"]`,
      );
      const key = (dir: string) =>
        step?.querySelector<HTMLButtonElement>(`[data-move="${dir}"]`);
      const other = landing.dir === "up" ? "down" : "up";
      const next = [key(landing.dir), key(other)].find(
        (button) => button && !button.disabled,
      );
      next?.focus();
    }
    setLanding(null);
  }, [landing, list]);
  return setLanding;
}
