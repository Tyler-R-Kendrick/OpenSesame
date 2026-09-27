/**
 * Focus a control once a change has landed.
 *
 * A confirmed delete, removal or claim can take the key that had focus away
 * with its row, which drops focus on <body> — the next Tab then starts from
 * the top of the page. A panel names the control to land on instead (its add
 * key, the claimed row's edit key), and this puts focus there as soon as the
 * panel is no longer busy, so the control is enabled when it is focused.
 */

import { useEffect, useState } from "react";

export function useFocusAfter(busy: boolean): (id: string) => void {
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (busy || !target) return;
    setTarget(null);
    document.getElementById(target)?.focus();
  }, [busy, target]);
  return setTarget;
}
