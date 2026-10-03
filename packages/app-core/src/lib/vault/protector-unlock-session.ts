/**
 * Unlock from an enrolled protector — a recovery key, an age identity or an age
 * passkey (ADR 0152). Kept out of vault/store.ts so the store line budget only
 * falls (ADR 0093).
 *
 * It mirrors the passkey road guard for guard, because it is the same shape: a
 * secret or ceremony opens the root, the root becomes the session, and the
 * authenticator gate (if enrolled) still stands between it and the vault.
 *
 * - the lockout is read first and every miss counts toward it, exactly as a
 *   wrong password does; a dismissed prompt does not;
 * - the root is stashed and handed to `afterPrimaryUnwrap`, which parks it for
 *   an enrolled second step or activates the session;
 * - the same two phases the passkey road has — `probe` opens the root, `held`
 *   spends it — so a complete-code duress gate can sit between them.
 */

import {
  ROOT_KEY_BYTES,
  WrongPasswordError,
  importVaultKey,
} from "@opensesame/vault-core";
import type { PasskeyUnlockSessionHost } from "./passkey-unlock-session.js";
import {
  type ProtectorUnlockInput,
  isUncountedProtectorFailure,
  openRootWithProtector,
  protectorUnlockMiss,
} from "./protection/unlock-protector-open.js";
import type { ProtectorUnlockMethodId } from "./protection/unlock-protector-methods.js";

export type { ProtectorUnlockInput };

function copyOf(root: Uint8Array): ArrayBuffer {
  return root.buffer.slice(
    root.byteOffset,
    root.byteOffset + root.byteLength,
  ) as ArrayBuffer;
}

/** Open the root from the protector; the caller owns (and must spend) it. */
export async function probeProtectorRoot(
  host: PasskeyUnlockSessionHost,
  input: ProtectorUnlockInput,
): Promise<ArrayBuffer> {
  host.assertNotLockedOut();
  const header = host.header();
  if (!header) throw new Error("There is no vault on this device yet.");
  let root: Uint8Array;
  try {
    root = await openRootWithProtector(header, input);
  } catch (error) {
    if (isUncountedProtectorFailure(error)) throw error;
    host.recordFailedUnlock();
    throw error instanceof WrongPasswordError
      ? error
      : new WrongPasswordError(protectorUnlockMiss(input.method));
  }
  try {
    return copyOf(root);
  } finally {
    root.fill(0);
  }
}

/** Become the session from a root `probeProtectorRoot` opened. */
export async function unlockVaultWithHeldRoot(
  host: PasskeyUnlockSessionHost,
  root: ArrayBuffer,
  method: ProtectorUnlockMethodId,
): Promise<void> {
  host.assertNotLockedOut();
  if (!host.header()) throw new Error("There is no vault on this device yet.");
  if (root.byteLength !== ROOT_KEY_BYTES) {
    host.recordFailedUnlock();
    throw new WrongPasswordError(protectorUnlockMiss(method));
  }
  const raw = new Uint8Array(root.slice(0));
  host.stashRaw(raw);
  const vaultKey = await importVaultKey(raw);
  await host.afterPrimaryUnwrap(vaultKey);
}

export async function unlockVaultWithProtector(
  host: PasskeyUnlockSessionHost,
  input: ProtectorUnlockInput,
): Promise<void> {
  const root = await probeProtectorRoot(host, input);
  try {
    await unlockVaultWithHeldRoot(host, root, input.method);
  } finally {
    new Uint8Array(root).fill(0);
  }
}
