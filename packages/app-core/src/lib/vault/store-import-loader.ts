/** A restore retains its original guarded body port while loading its computation. */
import type { VaultBodyPort } from "./store-device-key.js";
import type { ImportOptions } from "./store-import.js";
export type { ImportOptions } from "./store-import.js";

export async function importSealedInto(
  port: VaultBodyPort,
  fileText: string,
  secret: string | Uint8Array,
  options: ImportOptions = {},
): Promise<number> {
  try {
    // Every getter on this retained port checks its original store and realm.
    port.tomb();
    const operation = await import("./store-import.js");
    port.tomb();
    return await operation.importSealedInto(port, fileText, secret, options);
  } catch (error) {
    // A byte secret is the original consumed key handoff, never a successor key.
    if (secret instanceof Uint8Array) secret.fill(0);
    throw error;
  }
}
