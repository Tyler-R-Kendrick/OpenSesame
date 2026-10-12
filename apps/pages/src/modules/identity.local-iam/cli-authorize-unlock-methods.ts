import type { VaultHeader, VaultUnlocks } from "@opensesame/vault-core";

function listPasskeyUnlockRecords(
  unlocks: VaultUnlocks | null | undefined,
): readonly unknown[] {
  if (!unlocks) return [];
  const fromArray = unlocks.passkeys ?? [];
  if (fromArray.length > 0) {
    const legacy = unlocks.passkey;
    if (
      legacy &&
      !fromArray.some((row) => row.credentialIdB64 === legacy.credentialIdB64)
    ) {
      return [legacy, ...fromArray];
    }
    return fromArray;
  }
  return unlocks.passkey ? [unlocks.passkey] : [];
}

/** PIN / passkey only — matches `listAvailableUnlockMethods` without unlock-methods.js. */
export function cliAuthorizeProofMethods(
  header: VaultHeader | null | undefined,
): Array<"pin" | "passkey"> {
  if (!header) return [];
  const methods: Array<"pin" | "passkey"> = [];
  if (listPasskeyUnlockRecords(header.unlocks).length > 0) {
    methods.push("passkey");
  }
  if (header.unlocks?.pin) methods.push("pin");
  return methods;
}
