import { useCallback, useEffect, useState } from "react";

/**
 * State that belongs to one page of a section that stays mounted while its
 * route changes: a connector's flash, its vault reminder. A value is recorded
 * with the scope that set it, read back only on that scope, and dropped when
 * the scope moves on — so nothing provider A raised surfaces on provider B,
 * or comes back when A is opened again.
 */
export function useScopedState<T>(scope: string) {
  const [held, setHeld] = useState<{ scope: string; value: T } | null>(null);
  const value = held?.scope === scope ? held.value : null;
  const set = useCallback(
    (next: T | null) => setHeld(next === null ? null : { scope, value: next }),
    [scope],
  );
  useEffect(() => {
    setHeld((current) => (current && current.scope !== scope ? null : current));
  }, [scope]);
  return [value, set] as const;
}
