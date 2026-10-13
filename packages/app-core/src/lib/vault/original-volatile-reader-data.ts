/** Exact volatile Core transport only. Missing production ports never select this path. */
import { host } from "../../host.js";
import { lockManager } from "../../ports.js";
import { captureOriginalMemoryKvReadData, kvDurability, kvGet } from "../kv.js";
import { vfsSeams } from "../vfs-seams-state.js";
function hasNoOriginalPhysicalPorts(
  installed: ReturnType<typeof host>,
): boolean {
  return (
    installed.originFiles === undefined &&
    installed.physicalVaultAuthentication === undefined &&
    installed.physicalDeviceRecords === undefined &&
    installed.physicalCurrentCredentialCatalogue === undefined &&
    installed.physicalApplicationVaultWipe === undefined &&
    installed.physicalVaultGeneration === undefined &&
    installed.physicalVaultPublication === undefined
  );
}
export function captureOriginalVolatileReaderData(original: () => void) {
  original();
  const backing = captureOriginalMemoryKvReadData(original);
  if (!backing) return undefined;
  const installed = host();
  const atRestKeys = installed.atRestKeys;
  const locks = lockManager();
  const read = vfsSeams.readRaw;
  const memoryOnly = () =>
    host() === installed &&
    hasNoOriginalPhysicalPorts(installed) &&
    installed.atRestKeys === atRestKeys &&
    backing.current() &&
    vfsSeams.authenticationStorage === undefined &&
    vfsSeams.openBody === undefined &&
    vfsSeams.readRaw === read &&
    read === kvGet &&
    lockManager() === locks &&
    kvDurability() === "memory";
  if (!memoryOnly()) return undefined;
  let closed = false;
  const transport = () => {
    original();
    if (!memoryOnly())
      throw new Error("Original volatile reader transport changed.");
  };
  const check = () => {
    transport();
    if (closed) throw new Error("Original volatile reader closed.");
  };
  check();
  return Object.freeze({
    original: transport,
    check,
    async read(recordKey: string, maxBytes: number): Promise<string | null> {
      check();
      if (
        !recordKey ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        maxBytes > 16 * 1024 * 1024
      )
        throw new Error("Original volatile read bounds unavailable.");
      const value = backing.read(recordKey);
      check();
      if (
        value !== null &&
        (value.length > maxBytes ||
          new TextEncoder().encode(value).byteLength > maxBytes)
      )
        throw new Error("Original volatile ciphertext exceeds its bound.");
      return value;
    },
    revalidateRoot: async () => {
      check();
    },
    close: async () => {
      closed = true;
    },
  });
}
