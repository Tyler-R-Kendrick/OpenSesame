import { vi } from "vitest";

const queues = new Map<string, Promise<void>>();

function request(_name: string, action: () => Promise<void>): Promise<void>;
function request(
  _name: string,
  _options: { mode?: string },
  action: () => Promise<void>,
): Promise<void>;
function request(
  name: string,
  optionsOrAction: { mode?: string } | (() => Promise<void>),
  maybeAction?: () => Promise<void>,
): Promise<void> {
  // SAFETY: the checked two-argument Web Locks contract declares optionsOrAction as the callback; maybeAction is absent only on that branch.
  const action = maybeAction ?? (optionsOrAction as () => Promise<void>);
  const previous = queues.get(name) ?? Promise.resolve();
  const next = previous.then(action);
  queues.set(
    name,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export const testLockManager = { request };

/** Install a lock-manager stand-in for UI tests that work on separate locks. */
export function installTestLocks(): void {
  vi.stubGlobal("navigator", { locks: testLockManager });
}
