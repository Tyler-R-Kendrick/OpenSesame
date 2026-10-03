/**
 * Which protectors open this vault at the unlock screen, and which of them the
 * person prefers.
 *
 * Two kinds of protector open it. The header's own wraps — password, PIN, and
 * passkeys enrolled under Unlock methods — are the daily roads, and Unlock
 * methods is where they are added and removed. A manifest capsule whose
 * material the person can present with nothing sealed inside this vault — a
 * recovery key, an age identity, an age passkey, a passkey capsule — is the
 * other; its row in Vault key protection adds and removes it. A cloud KMS
 * capsule cannot be one: its credential is sealed in the vault it protects
 * (docs/adr/0152-browser-key-protector-enrollment.md).
 *
 * "Preferred unlock" is a choice among everything that opens the vault, and it
 * picks the unlock screen's default tab.
 */

import type {
  ProofStatus,
  ProtectorKind,
  VaultHeader,
} from "@opensesame/vault-core";
import {
  type UnlockTabId,
  capsuleTabOf,
  listProtectorUnlockTabs,
} from "./protection/unlock-protector-methods.js";
import type { UnlockMethodId } from "./unlock-methods.js";

type PreferableRecord = {
  kind: ProtectorKind;
  legacy?: boolean;
  proofStatus?: ProofStatus;
};

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
export function protectorIsHeaderWrap(record: PreferableRecord): boolean {
  if (record.kind === "webauthn-prf") return record.legacy === true;
  return methodOf(record.kind) !== null;
}

/** The unlock tab a record opens the vault through, or null when none. */
function tabOf(record: PreferableRecord): UnlockTabId | null {
  if (protectorIsHeaderWrap(record)) return methodOf(record.kind);
  return capsuleTabOf(record);
}

/**
 * True when the unlock screen can open the vault from this record: a header
 * wrap, or a capsule whose proof is current. It is what makes a row
 * preferable; removing a header wrap is `protectorIsHeaderWrap`'s question.
 */
export function protectorUnlocksVault(record: PreferableRecord): boolean {
  return tabOf(record) !== null;
}

/**
 * The method the person preferred in Vault key protection when this header
 * offers it, else passkey, PIN, password in that order — the fastest road
 * first — and a protector only when nothing else is enrolled.
 */
export function chooseUnlockMethod(
  header: VaultHeader | null | undefined,
  methods: readonly UnlockTabId[],
): UnlockTabId | null {
  const offered = [...methods, ...listProtectorUnlockTabs(header)];
  const manifest = header?.protection;
  const chosen = manifest?.records.find(
    (record) => record.protectorId === manifest.preferredProtectorId,
  );
  const preferred = chosen ? tabOf(chosen) : null;
  if (preferred && offered.includes(preferred)) return preferred;
  for (const method of [
    "passkey",
    "pin",
    "password",
    "agePasskey",
    "age",
    "recovery",
  ] as const) {
    if (offered.includes(method)) return method;
  }
  return null;
}
