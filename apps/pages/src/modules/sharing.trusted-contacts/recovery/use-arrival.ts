/**
 * Where the keyboard goes when a ceremony ends in a row that was not there.
 *
 * A sheet that closes hands the keyboard back to the key that opened it. When
 * what the person just did made a new row, that key is no longer the next
 * thing to do: the new row's key is. This puts the keyboard there once the
 * render that draws it has settled, after the sheet has given the focus back.
 */

import { useEffect, useState } from "react";
import { landFocus } from "../../../lib/focus.js";

export function useArrival(): (id: string) => void {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (id === null) return;
    setId(null);
    landFocus(document.getElementById(id));
  }, [id]);
  return setId;
}
