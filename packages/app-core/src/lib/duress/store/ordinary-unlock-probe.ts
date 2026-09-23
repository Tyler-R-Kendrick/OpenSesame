/**
 * Refuse a duress code that is also an ordinary unlock secret (TRIGGER-F).
 *
 * The duress check runs on the complete code before any vault unwrap, so a
 * trigger equal to a vault's own PIN or master password would make that
 * secret open the decoy every time. Enrollment is device-wide — the unlock
 * bridge consults it on every tomb's unlock screen — so every vault header on
 * this device is tried, the way unlock itself would try it.
 */

import {
  type VaultHeader,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { readTombHeader } from "../../vault/store-header.js";
import { unwrapVaultKeyWithPin } from "../../vault/unlock-methods.js";
import { GUEST_TOMB, PERSONAL_TOMB, listTombs } from "../../vfs.js";

async function opens(unwrap: () => Promise<Uint8Array>): Promise<boolean> {
  try {
    const raw = await unwrap();
    raw.fill(0);
    return true;
  } catch {
    // A wrong secret, a secret outside the PIN policy, or a record this
    // build cannot read: none of them is a code that opens the vault.
    return false;
  }
}

/** True when `code` unwraps this header's PIN or master-password record. */
export async function codeOpensVaultHeader(
  code: string,
  header: VaultHeader,
): Promise<boolean> {
  const pin = header.unlocks?.pin;
  if (pin && (await opens(() => unwrapVaultKeyWithPin(pin, code)))) {
    return true;
  }
  if (!header.wrap || !header.kdf) return false;
  return opens(() => unwrapRawVaultKeyFromPassword(header, code));
}

/** Every vault header on this device: personal, projects, and the guest tomb. */
export function deviceVaultHeaders(): VaultHeader[] {
  const tombs = new Set([PERSONAL_TOMB, GUEST_TOMB, ...listTombs()]);
  const headers: VaultHeader[] = [];
  for (const tomb of tombs) {
    const header = readTombHeader(tomb);
    if (header) headers.push(header);
  }
  return headers;
}

/** True when `code` opens any vault on this device with its PIN or password. */
export async function codeOpensDeviceVault(
  code: string,
  headers: readonly VaultHeader[] = deviceVaultHeaders(),
): Promise<boolean> {
  for (const header of headers) {
    if (await codeOpensVaultHeader(code, header)) return true;
  }
  return false;
}
