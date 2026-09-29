import { type RefObject, useEffect, useState } from "react";

/**
 * Where focus goes when the control that had it is gone or done: the first of
 * `selectors` that is drawn inside `scope`. Only when nobody moved it — focus
 * on nothing, or still on the key that was just pressed (`data-resets`) —
 * never one the person has already carried elsewhere.
 */
export function useFocusLanding(scope: RefObject<HTMLElement | null>) {
  const [landing, setLanding] = useState<readonly string[] | null>(null);
  useEffect(() => {
    if (landing === null) return;
    const active = document.activeElement;
    const idle =
      active === null ||
      active === document.body ||
      active.hasAttribute("data-resets");
    if (idle) {
      for (const selector of landing) {
        const next = scope.current?.querySelector<HTMLElement>(selector);
        if (next) {
          next.focus();
          break;
        }
      }
    }
    setLanding(null);
  }, [landing, scope]);
  return setLanding;
}
