/**
 * A screen Wake Lock for one visible, bounded file operation.
 *
 * The lock is requested only by the action that needs it, is released when
 * the tab hides, and is released again when the operation settles. A browser
 * without the API, or a denied request, runs the operation normally.
 */

type WakeLockSentinel = {
  release: () => Promise<void>;
  released: boolean;
  addEventListener?: (type: "release", listener: () => void) => void;
};

type WakeLockHost = {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
};

type VisibilityHost = {
  visibilityState?: DocumentVisibilityState;
  addEventListener?: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener?: (
    type: "visibilitychange",
    listener: () => void,
  ) => void;
};

export type WakeLockRelease = () => Promise<void>;

function platformWakeLock(): WakeLockHost {
  // SAFETY: wakeLock is optional on WakeLockHost, so the navigator matches it in a browser without the Screen Wake Lock API; holdWakeLock checks it.
  return globalThis.navigator as WakeLockHost;
}

function pageVisibility(): VisibilityHost {
  // SAFETY: every VisibilityHost member is optional and matches the document's own; holdWakeLock checks each one before calling it.
  return globalThis.document as VisibilityHost;
}

/** Acquire a lock, or a no-op release when the platform cannot provide one. */
export async function holdWakeLock(
  host: WakeLockHost = platformWakeLock(),
  visibility: VisibilityHost = pageVisibility(),
): Promise<WakeLockRelease> {
  let sentinel: WakeLockSentinel | null = null;
  try {
    sentinel = (await host.wakeLock?.request("screen")) ?? null;
  } catch {
    return async () => undefined;
  }
  if (sentinel === null) return async () => undefined;

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    visibility.removeEventListener?.("visibilitychange", onHide);
    await sentinel?.release().catch(() => undefined);
  };
  const onHide = () => {
    if (visibility.visibilityState === "hidden") void release();
  };
  visibility.addEventListener?.("visibilitychange", onHide);
  sentinel.addEventListener?.("release", () => {
    released = true;
    visibility.removeEventListener?.("visibilitychange", onHide);
  });
  return release;
}

/** Run one task under a best-effort lock; the task always settles. */
export async function withWakeLock<T>(task: () => Promise<T>): Promise<T> {
  const release = await holdWakeLock();
  try {
    return await task();
  } finally {
    await release();
  }
}
