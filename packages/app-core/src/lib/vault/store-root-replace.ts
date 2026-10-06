import { importVaultKey } from "@opensesame/vault-core";

/** Intentional key replacement still belongs to the original scope and epoch. */
export async function replaceSessionRoot(
  next: Uint8Array,
  assertCurrent: () => void,
  install: (raw: Uint8Array, key: CryptoKey) => void,
  persist: () => Promise<void>,
): Promise<void> {
  try {
    assertCurrent();
    const key = await importVaultKey(next);
    assertCurrent();
    install(next, key);
    await persist();
    assertCurrent();
  } catch (error) {
    next.fill(0);
    throw error;
  }
}
