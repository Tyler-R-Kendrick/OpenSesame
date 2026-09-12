import { useEffect, useState } from "react";

/** Whole seconds until `until`, ticking once a second; 0 when there is none. */
export function useCountdown(until: number | null): number {
  const [remaining, setRemaining] = useState(() =>
    until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0,
  );
  useEffect(() => {
    if (!until) {
      setRemaining(0);
      return;
    }
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return remaining;
}
