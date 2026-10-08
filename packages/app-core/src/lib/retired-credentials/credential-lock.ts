/** Inactive one cross-tab lock for complete credential transactions. */
import { lockManager } from "../../ports.js";
import { kvRefresh } from "../kv.js";
export const CREDENTIAL_LOCK_NAME = "opensesame.retired-credentials";
export const retiredCredentialStorageSeams = {
  locks: lockManager,
  refresh: kvRefresh,
};
let busy = false;
/** Caller awaits refresh, collision checks and durable commit inside work. */
export async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (busy)
    throw new Error("A credential check is already running. Try again.");
  busy = true;
  try {
    const locks = retiredCredentialStorageSeams.locks();
    if (!locks) throw new Error("Cross-tab credential locking is required.");
    return await locks.request(
      CREDENTIAL_LOCK_NAME,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new Error("A credential check is already running. Try again.");
        return await work();
      },
    );
  } finally {
    busy = false;
  }
}
