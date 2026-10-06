/** Load root replacement and ciphertext recovery only for their guarded operations. */
import type { VaultHeader } from "@opensesame/vault-core";
import type { StoreWriteBarrier } from "../vfs-write-queue.js";

export async function rotateRootDataset(
  chain: StoreWriteBarrier,
  tomb: string,
  old: CryptoKey | null,
  header: VaultHeader | null,
  raw: Uint8Array,
  replacement: VaultHeader,
  check: () => void,
) {
  try {
    check();
    const operation = await import("./store-root-rotation.js");
    check();
    return await operation.rotateRootDataset(
      chain,
      tomb,
      old,
      header,
      raw,
      replacement,
      check,
    );
  } catch (error) {
    raw.fill(0);
    throw error;
  }
}

export async function recoverPreparedRoot(
  tomb: string,
  fallback: VaultHeader | null,
  check: () => void,
): Promise<VaultHeader | null> {
  check();
  const operation = await import("./store-root-rotation.js");
  check();
  return operation.recoverPreparedRoot(tomb, fallback, check);
}
