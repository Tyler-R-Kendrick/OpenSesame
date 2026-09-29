/**
 * Which protectors open this vault at the unlock screen, and which of them the
 * person prefers.
 *
 * Only the wraps in the header's `unlocks` open it — password, PIN, and
 * passkeys enrolled under Unlock methods. Every other protector the manifest
 * carries (a recovery key, an age recipient, a cloud key, a passkey capsule
 * enrolled beside it) is a capsule that opens the root when its own material
 * is presented and that Test proves; nothing at the unlock screen reads it. So
 * "preferred unlock" is a choice among the wraps, and only they can hold it.
 */

import type { ProtectorKind, VaultHeader } from "@opensesame/vault-core";
import type { UnlockMethodId } from "./unlock-methods.js";

function methodOf(kind: ProtectorKind): UnlockMethodId | null {
  switch (kind) {
    case "password":
      return "password";
    case "pin":
      return "pin";
    case "webauthn-prf":
      return "passkey";
    default:
      return null;
  }
}

/** True for a projection of one of the header's own unlock wraps. */
export function protectorUnlocksVault(record: {
  kind: ProtectorKind;
  legacy?: boolean;
}): boolean {
  if (record.kind === "webauthn-prf") return record.legacy === true;
  return methodOf(record.kind) !== null;
}

/**
 * The method the person preferred in Vault key protection when this header
 * offers it, else passkey, PIN, password in that order — the fastest road
 * first.
 */
export function chooseUnlockMethod(
  header: VaultHeader | null | undefined,
  methods: readonly UnlockMethodId[],
): UnlockMethodId | null {
  const manifest = header?.protection;
  const chosen = manifest?.records.find(
    (record) => record.protectorId === manifest.preferredProtectorId,
  );
  if (chosen && protectorUnlocksVault(chosen)) {
    const method = methodOf(chosen.kind);
    if (method && methods.includes(method)) return method;
  }
  for (const method of ["passkey", "pin", "password"] as const) {
    if (methods.includes(method)) return method;
  }
  return null;
}
