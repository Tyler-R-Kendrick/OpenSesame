/**
 * Sealed connection files nothing reads any more.
 *
 * A YubiKey recipient and an Azure Key Vault service principal were once saved
 * in the tomb so a setup preference could name them. A browser cannot enroll
 * either as a vault key protector (docs/adr/0152), so no screen shows, uses or
 * removes them — and a service-principal secret with no way to delete it is a
 * credential left lying in the vault. Each unlock removes them; the delete is
 * idempotent, so a device that never held one pays a lookup.
 */

import { deleteFile } from "../vfs.js";

export const RETIRED_CONFIG_PATHS = [
  "config/yubikey",
  "config/azure-key-vault-keys",
] as const;

export async function retireUnusedConnectionConfigs(
  tomb: string,
): Promise<void> {
  for (const path of RETIRED_CONFIG_PATHS) {
    try {
      await deleteFile(tomb, path);
    } catch {
      // A file that is not there is the usual state; one that could not be
      // removed waits for the next unlock rather than failing this one over
      // housekeeping.
    }
  }
}
