/** One cross-tab lock for credential collisions and authority commits. */
import { lockManager } from "../../ports.js";
import { kvRefresh } from "../kv.js";
export const retiredCredentialStorageSeams = {
  locks: lockManager,
  refresh: kvRefresh,
};
let busy = false;
export async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (busy)
    throw new Error("A credential check is already running. Try again.");
  busy = true;
  try {
    const locks = retiredCredentialStorageSeams.locks();
    if (!locks) throw new Error("Cross-tab credential locking is required.");
    return await locks.request(
      "opensesame.retired-credentials",
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new Error("A credential check is already running. Try again.");
        return work();
      },
    );
  } finally {
    busy = false;
  }
}
