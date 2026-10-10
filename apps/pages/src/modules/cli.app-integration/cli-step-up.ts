import { passkeyUnlockRecords } from "@opensesame/app-core/lib/vault/passkey-unlock-session.js";
import { PIN_MISS, unwrapPin } from "@opensesame/app-core/lib/vault/primary-unwrap.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  unwrapVaultKeyWithPrf,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { WrongPasswordError, importVaultKey } from "@opensesame/vault-core";

const PASSKEY_MISS = "That passkey did not unlock the vault.";

async function assertOpenVaultKeyMatches(
  current: CryptoKey | null,
  candidate: CryptoKey,
  onMiss: () => void,
  miss: string,
): Promise<void> {
  if (!current) throw new Error("Unlock OpenSesame first.");
  const [left, right] = await Promise.all([
    crypto.subtle.exportKey("raw", current),
    crypto.subtle.exportKey("raw", candidate),
  ]);
  if (left.byteLength !== right.byteLength) {
    onMiss();
    throw new WrongPasswordError(miss);
  }
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      onMiss();
      throw new WrongPasswordError(miss);
    }
  }
}

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
  const seam = store.stepUpSeam();
  await assertOpenVaultKeyMatches(
    seam.key,
    derived,
    seam.onMiss,
    PASSKEY_MISS,
  );
}

export async function confirmPinStepUpForCli(
  store: VaultStore,
  pin: string,
): Promise<void> {
  const snap = store.getSnapshot();
  if (snap.status !== "unlocked" || !snap.header) {
    throw new Error("Unlock OpenSesame first.");
  }
  const seam = store.stepUpSeam();
  const raw = await unwrapPin(snap.header, pin, seam.onMiss);
  const derived = await importVaultKey(raw);
  await assertOpenVaultKeyMatches(seam.key, derived, seam.onMiss, PIN_MISS);
}
