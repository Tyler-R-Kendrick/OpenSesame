/** One lock order for session mutations and the shares they issue: session, then share. */
import { lockManager } from "../ports.js";
import { kvDurability, kvRefresh } from "./kv.js";
import { tombFileKey } from "./vfs.js";

const chains = new Map<string, Promise<unknown>>();

export function withLocalAccessLedgerLock<T>(
  tomb: string,
  ledger: "session" | "share" | "audit" | "receipts",
  path: string,
  maxBytes: number,
  action: () => Promise<T>,
): Promise<T> {
  const name = `opensesame:local-${ledger}:${tomb}`;
  const run = (chains.get(name) ?? Promise.resolve()).then(async () => {
    const key = tombFileKey(tomb, path);
    const locks = lockManager();
    if (locks)
      return locks.request(name, async () => {
        await kvRefresh(key, maxBytes);
        return action();
      });
    await kvRefresh(key, maxBytes);
    if (kvDurability() === "persistent")
      throw new Error("Web Locks are required for shared access writes.");
    return action();
  });
  chains.set(
    name,
    run.catch(() => undefined),
  );
  return run;
}
