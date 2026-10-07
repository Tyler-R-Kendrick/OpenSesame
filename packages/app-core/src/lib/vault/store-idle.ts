/** The idle deadline follows activity, never a stale initial timestamp. */
export function scheduleIdleLock(
  windowMs: number,
  idleFor: () => number,
  lock: () => void,
  installTimer: (timer: ReturnType<typeof setTimeout>) => void,
): ReturnType<typeof setTimeout> | null {
  if (windowMs <= 0) return null;
  const tick = () => {
    const remaining = windowMs - idleFor();
    if (remaining <= 0) {
      lock();
      return;
    }
    installTimer(setTimeout(tick, Math.max(1_000, remaining)));
  };
  return setTimeout(tick, windowMs);
}
