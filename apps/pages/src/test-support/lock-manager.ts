import { vi } from "vitest";

function request(_name: string, action: () => Promise<void>): Promise<void>;
function request(
  _name: string,
  _options: { mode?: string },
  action: () => Promise<void>,
): Promise<void>;
function request(
  _name: string,
  optionsOrAction: { mode?: string } | (() => Promise<void>),
  maybeAction?: () => Promise<void>,
): Promise<void> {
  if (maybeAction) return maybeAction();
  // SAFETY: the checked two-argument Web Locks contract declares optionsOrAction as the callback; maybeAction is absent only on that branch.
  return (optionsOrAction as () => Promise<void>)();
}

export const testLockManager = { request };

/** Install a lock-manager stand-in for UI tests that work on separate locks. */
export function installTestLocks(): void {
  vi.stubGlobal("navigator", { locks: testLockManager });
}
