import { lockManager } from "../ports.js";
import { kvDurability } from "./kv.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";

// Never queue confirmation behind issuance: the user's provider-side action
// must happen after any in-flight mutation has finished.
const active = new Set<string>();
export async function withNativeMcpMutationLock<T>(
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  if (active.has(id)) throw new NativeMcpAuthError("pending");
  active.add(id);
  try {
    const locks = lockManager();
    if (!locks && kvDurability() === "persistent")
      throw new NativeMcpAuthError("pending");
    if (!locks) return await action();
    return await locks.request(
      `opensesame:native-mcp-mutation:${id}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) throw new NativeMcpAuthError("pending");
        return action();
      },
    );
  } finally {
    active.delete(id);
  }
}
