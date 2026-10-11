/**
 * A field that commits what was typed once the typing settles, and when the
 * person leaves it or the sheet closes under it. A secret's value is sealed
 * into the vault on every commit, so it is not written per keystroke; and a
 * value that arrives from the vault while the person is mid-word never
 * overwrites what they are typing.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const SETTLE_MS = 450;

export type Draft = Readonly<{
  value: string;
  change: (next: string) => void;
  /** Commit now: on blur, or Enter. */
  flush: () => void;
}>;

export function useDraft(
  saved: string,
  commit: (value: string) => void,
): Draft {
  const [value, setValue] = useState(saved);
  const pending = useRef(false);
  const latest = useRef(saved);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // The vault's own value arrives (another device, a removal): take it unless
  // a keystroke of this field has not been committed yet.
  useEffect(() => {
    if (pending.current) return;
    latest.current = saved;
    setValue(saved);
  }, [saved]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    pending.current = false;
    commitRef.current(latest.current);
  }, []);

  const change = useCallback(
    (next: string) => {
      latest.current = next;
      pending.current = true;
      setValue(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, SETTLE_MS);
    },
    [flush],
  );

  // Closing the sheet is not a blur: commit what is waiting before it goes.
  useEffect(() => flush, [flush]);

  return { value, change, flush };
}
