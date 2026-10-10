import { passkeyUnlockRecords } from "@opensesame/app-core/lib/vault/passkey-unlock-session.js";
import { PIN_MISS, unwrapPin } from "@opensesame/app-core/lib/vault/primary-unwrap.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  unwrapVaultKeyWithPrf,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { WrongPasswordError, importVaultKey } from "@opensesame/vault-core";

const PASSKEY_MISS = "That passkey did not unlock the vault.";

export async function confirmPasskeyStepUpForCli(
  store: VaultStore,
  signal?: AbortSignal,
): Promise<void> {
  const snap = store.getSnapshot();
  if (snap.status !== "unlocked" || !snap.header) {
    throw new Error("Unlock OpenSesame first.");
  }
  const probe = await store.probePasskeyCeremony(signal ? { signal } : {});
  let raw: Uint8Array | null = null;
  for (const record of passkeyUnlockRecords(snap.header)) {
    try {
      raw = await unwrapVaultKeyWithPrf(record, probe.prfOutput);
      break;
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error;
    }
  }
  if (!raw) {
    throw new WrongPasswordError(PASSKEY_MISS);
  }
  const derived = await importVaultKey(raw);
  await store.assertMatchesOpenVaultKey(derived, PASSKEY_MISS);
}

export async function confirmPinStepUpForCli(
  store: VaultStore,
  pin: string,
): Promise<void> {
  const snap = store.getSnapshot();
  if (snap.status !== "unlocked" || !snap.header) {
    throw new Error("Unlock OpenSesame first.");
  }
  const recordFailed = () => store.noteFailedUnlock();
  const raw = await unwrapPin(snap.header, pin, recordFailed);
  const derived = await importVaultKey(raw);
  await store.assertMatchesOpenVaultKey(derived, PIN_MISS);
}
