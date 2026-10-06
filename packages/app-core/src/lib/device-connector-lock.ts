/** Device metadata writers serialize fresh reads across browser tabs and processes. */
import { lockManager } from "../ports.js";
import { LEGACY_CONNECTOR_PUBLIC_KEY } from "./device-connector-legacy-storage.js";
import {
  assertDeviceConnectorPrincipal,
  requireDeviceConnectorPrincipal,
} from "./device-connector-principal.js";
import { kvDurability, kvRefresh } from "./kv.js";
let tail: Promise<void> = Promise.resolve();
export function withDeviceConnectorMetadata<T>(
  work: () => Promise<T>,
): Promise<T> {
  const original = requireDeviceConnectorPrincipal();
  const run = async () => {
    const enter = async () => {
      assertDeviceConnectorPrincipal(original);
      await kvRefresh(LEGACY_CONNECTOR_PUBLIC_KEY, 262144);
      assertDeviceConnectorPrincipal(original);
      const result = await work();
      assertDeviceConnectorPrincipal(original);
      return result;
    };
    const locks = lockManager();
    if (locks)
      return locks.request(
        "opensesame.device-connector-metadata",
        { mode: "exclusive" },
        enter,
      );
    if (kvDurability() === "persistent")
      throw new Error("Cross-document connector locking is required.");
    return enter();
  };
  const result = tail.then(run);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
