import type { NativeDataProcess } from "./native-data-process.js";
import { unavailable } from "./native-vault-data.js";

const capturedInventories = new WeakSet<NativeDataProcess>();
export async function inventoryNames(
  process: NativeDataProcess,
): Promise<readonly string[]> {
  if (!capturedInventories.has(process)) {
    await process.request({ kind: "capture_inventory" });
    capturedInventories.add(process);
  }
  const reply = await process.request({ kind: "inventory_tombs" });
  if (reply.kind !== "names") unavailable();
  return reply.values;
}

export async function releaseInventory(process: NativeDataProcess | undefined) {
  if (process && capturedInventories.has(process)) {
    await process.request({ kind: "inventory_close" });
    capturedInventories.delete(process);
  }
}
