/**
 * Open a sealed JSON value that should be bound to its path, accepting a
 * legacy unbound seal once so the caller can rewrite it bound
 * (`seal-rebind.ts`). Pure: the key and the blob are all it needs.
 */
import { type SealedBlob, VaultCorruptError, openJson } from "./crypto.js";

export type ReboundSeal<T> = {
  readonly value: T;
  readonly rebound: boolean;
};

/** Open unbound once so unlock can rewrite the seal with a path binding. */
export async function openJsonForRebind<T>(
  vaultKey: CryptoKey,
  blob: SealedBlob,
  binding: string,
): Promise<ReboundSeal<T>> {
  try {
    const bound = {
      value: await openJson(vaultKey, blob, binding),
      rebound: false as const,
    } satisfies ReboundSeal<T>;
    return bound;
  } catch (error) {
    if (!(error instanceof VaultCorruptError)) throw error;
    const unbound = {
      value: await openJson(vaultKey, blob),
      rebound: true as const,
    } satisfies ReboundSeal<T>;
    return unbound;
  }
}
