/** Sealed writes and ciphertext-only rotation commits share one cross-tab boundary. */
import { lockManager } from "../ports.js";
import { kvDurability, kvGet, kvRefresh } from "./kv.js";
/** Completion barrier; its settled value carries no authority or payload. */
export type StoreWriteBarrier = Promise<void>;
const chains = new Map<string, Promise<unknown>>();
const pending = new Set<Promise<unknown>>();
export function trackSealedWork<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  const done = () => {
    pending.delete(work);
  };
  work.then(done, done);
  return work;
}
export function enqueueVfsWrite<T>(
  tomb: string,
  action: () => Promise<T>,
  exclusive = false,
): Promise<T> {
  const run = (chains.get(tomb) ?? Promise.resolve()).then(async () => {
    const guarded = async () => {
      await kvRefresh(`tomb/${tomb}/header`, 1024 * 1024);
      await kvRefresh(`tomb/${tomb}/index`, 16 * 1024 * 1024);
      await kvRefresh(`tomb/${tomb}/rotation-journal.v1`, 16 * 1024 * 1024);
      if (!exclusive && kvGet(`tomb/${tomb}/rotation-journal.v1`) !== null)
        throw new Error(
          "A vault root rotation needs recovery before sealed writes.",
        );
      return action();
    };
    const locks = lockManager();
    if (locks)
      return locks.request(
        `opensesame:vfs-rotation:${tomb}`,
        { mode: exclusive ? "exclusive" : "shared" },
        guarded,
      );
    if (exclusive && kvDurability() === "persistent")
      throw new Error("Web Locks are required for vault root rotation.");
    return guarded();
  });
  chains.set(
    tomb,
    run.catch(() => undefined),
  );
  return trackSealedWork(run);
}
export async function flushVfsWrites(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
