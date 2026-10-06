import type { VaultHeader } from "@opensesame/vault-core";
import type { GuardedUnlockHost } from "./primary-unlock-session.js";

type UnlockCallbacks = {
  header: VaultHeader | null;
  assertCurrent(): void;
  assertNotLockedOut(): void;
  recordFailedUnlock(): void;
  stashRaw(raw: Uint8Array): void;
  afterPrimaryUnwrap(key: CryptoKey, miss?: string): Promise<void>;
};

/** A protector's callbacks retain the original admission context, not future state. */
export function guardedUnlockHost(
  callbacks: UnlockCallbacks,
): GuardedUnlockHost {
  const check = callbacks.assertCurrent;
  return {
    assertCurrent: check,
    header: () => {
      check();
      return callbacks.header;
    },
    assertNotLockedOut: () => {
      check();
      callbacks.assertNotLockedOut();
    },
    recordFailedUnlock: () => {
      check();
      callbacks.recordFailedUnlock();
    },
    stashRaw: (raw) => {
      try {
        check();
        callbacks.stashRaw(raw);
      } catch (error) {
        raw.fill(0);
        throw error;
      }
    },
    afterPrimaryUnwrap: async (key, miss) => {
      check();
      await callbacks.afterPrimaryUnwrap(key, miss);
      check();
    },
  };
}
