/**
 * Passkey unlock path when duress may be armed (INV-03 / alternate wrappers).
 *
 * Application-code triggers stay PIN/password-gated; passkey may open the
 * ordinary root. Two-input triggers (UV+code / PRF+code) must not release the
 * protected root from passkey alone — fail closed with the ordinary miss surface.
 */

import { WrongPasswordError } from "../../lib/vault/crypto.js";
import { loadEnrollmentStateForUnlock } from "../../sections/settings/security/duress-unlock-bridge.js";

export type PasskeyUnlockResult = "vault_opened";

type PasskeyUnlockStore = Readonly<{
  unlockWithPasskey: (signal?: AbortSignal) => Promise<void>;
}>;

function armedTwoInputTrigger(): boolean {
  const state = loadEnrollmentStateForUnlock();
  if (!state?.armed || state.triggers.length === 0) return false;
  return state.triggers.some(
    (t) =>
      t.triggerKind === "prf_and_code" ||
      t.triggerKind === "verified_uv_then_code",
  );
}

export async function unlockWithPasskeyAfterDuressGate(
  store: PasskeyUnlockStore,
  signal?: AbortSignal,
): Promise<PasskeyUnlockResult> {
  if (armedTwoInputTrigger()) {
    throw new WrongPasswordError("That passkey did not unlock the vault.");
  }
  await store.unlockWithPasskey(signal);
  return "vault_opened";
}
