/** Captured original lock IO only; an object or callback is never a lease grant. */
import { host } from "../../host.js";
import { lockManager } from "../../ports.js";
const actualHost = host;
const actualLocks = lockManager;
export function captureRetiredOperationLockData(original: () => void) {
  const owner = actualHost();
  const locks = actualLocks();
  const request = locks?.request;
  if (!locks || !request)
    throw new Error("Original credential locking is required.");
  const check = () => {
    original();
    if (
      actualHost() !== owner ||
      actualLocks() !== locks ||
      locks.request !== request
    )
      throw new Error("Original credential lock transport changed.");
  };
  check();
  return Object.freeze({ locks, request, check });
}
export function checkRetiredOperationGrant(
  lock: Lock | null,
  name: string,
): void {
  if (!lock || lock.name !== name || lock.mode !== "exclusive")
    throw new Error("The actual original credential lease was not granted.");
}

export const capture = captureRetiredOperationLockData;
export const granted = checkRetiredOperationGrant;
