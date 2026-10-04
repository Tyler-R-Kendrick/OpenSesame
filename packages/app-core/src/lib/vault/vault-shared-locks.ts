/** Cross-tab serialization for sealed body writes and open-vault root rotation. */
import { lockManager } from "../../ports.js";
import { kvDurability, kvRefresh } from "../kv.js";
import { BODY_PATH, HEADER_PATH, tombFileKey } from "../vfs.js";

export class VaultStoreConflictError extends Error {
  constructor() {
    super("Vault changed in another tab. Review the latest item and retry.");
    this.name = "VaultStoreConflictError";
  }
}

const MAX_SHARED_BODY_BYTES = 256 * 1024 * 1024;
const MAX_SHARED_HEADER_BYTES = 1024 * 1024;
const bodyWriteChains = new Map<string, Promise<unknown>>();
const openLeaseCounts = new Map<string, number>();

function releaseCount(tomb: string): void {
  const remaining = (openLeaseCounts.get(tomb) ?? 1) - 1;
  if (remaining > 0) openLeaseCounts.set(tomb, remaining);
  else openLeaseCounts.delete(tomb);
}

export async function acquireOpenLease(
  tomb: string,
): Promise<() => Promise<void>> {
  openLeaseCounts.set(tomb, (openLeaseCounts.get(tomb) ?? 0) + 1);
  const locks = lockManager();
  if (!locks) return async () => releaseCount(tomb);
  let release = () => {};
  let held: Promise<void> = Promise.resolve();
  try {
    await new Promise<void>((resolve, reject) => {
      held = locks
        .request(
          `opensesame:vault-open:${tomb}`,
          { mode: "shared" },
          async () => {
            await new Promise<void>((done) => {
              release = done;
              resolve();
            });
          },
        )
        .catch(reject);
    });
  } catch (error) {
    releaseCount(tomb);
    throw error;
  }
  return async () => {
    release();
    releaseCount(tomb);
    await held;
  };
}

export async function withExclusiveOpenLease<T>(
  tomb: string,
  action: () => Promise<T>,
): Promise<T> {
  if ((openLeaseCounts.get(tomb) ?? 0) !== 0)
    throw new VaultStoreConflictError();
  const locks = lockManager();
  if (locks)
    return locks.request(
      `opensesame:vault-open:${tomb}`,
      { mode: "exclusive", ifAvailable: true },
      (lock) => {
        if (!lock) throw new VaultStoreConflictError();
        return action();
      },
    );
  if (kvDurability() === "persistent")
    throw new Error("Web Locks are required for vault root rotation.");
  return action();
}

/**
 * `withBodyWriteLock`, except where the browser has stored files that outlive
 * the page and no Web Locks to serialize them: there it runs bare, as a write
 * always did, rather than refusing every edit. A write that must not run
 * unlocked (a restore, the identity key) uses `withBodyWriteLock` and fails
 * there.
 */
export function withBodyWriteLockOrBare<T>(
  tomb: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!lockManager() && kvDurability() === "persistent") return action();
  return withBodyWriteLock(tomb, action);
}

export function withBodyWriteLock<T>(
  tomb: string,
  action: () => Promise<T>,
): Promise<T> {
  const run = (bodyWriteChains.get(tomb) ?? Promise.resolve()).then(
    async () => {
      const locks = lockManager();
      const guarded = async () => {
        await kvRefresh(tombFileKey(tomb, BODY_PATH), MAX_SHARED_BODY_BYTES);
        await kvRefresh(
          tombFileKey(tomb, HEADER_PATH),
          MAX_SHARED_HEADER_BYTES,
        );
        return action();
      };
      if (locks) return locks.request(`opensesame:vault-body:${tomb}`, guarded);
      await kvRefresh(tombFileKey(tomb, BODY_PATH), MAX_SHARED_BODY_BYTES);
      if (kvDurability() === "persistent")
        throw new Error("Web Locks are required for shared vault writes.");
      return guarded();
    },
  );
  bodyWriteChains.set(
    tomb,
    run.catch(() => undefined),
  );
  return run;
}
