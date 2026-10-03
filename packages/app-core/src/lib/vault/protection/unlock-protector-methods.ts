/**
 * Which manifest protectors open the vault at the unlock screen (ADR 0152).
 *
 * The header is plaintext, and `header.protection.records` carries each
 * capsule whole — only the manifest's MAC needs the root, so the records are
 * readable before unlock and the screen can name exactly the roads enrolled.
 * A protector is a road in only when the person can present its material with
 * nothing sealed inside this same vault:
 *
 * - a recovery key (the shown-once secret, typed),
 * - an age identity (typed; the vault's own sealed identities are unreachable
 *   until unlock, so a capsule opened with one is not offered here),
 * - an age passkey (a WebAuthn ceremony the record names itself),
 * - a passkey capsule enrolled in the manifest (a PRF ceremony).
 *
 * A cloud KMS record is never one: its credential is sealed in the vault it
 * protects (KP-37), so presenting it needs the vault already open. YubiKey PIV
 * has no browser road, and device-local and Azure Key Vault Keys are not
 * enrolled by the browser at all. None is drawn at unlock.
 *
 * Only a record whose proof is current counts: an untested recipient has never
 * been opened with its identity, and drawing it as a way in would invite an
 * attempt that can only count against the lockout.
 */

import type { ProtectionRecord, VaultHeader } from "@opensesame/vault-core";

/** The tabs a protector adds to the unlock screen, beside the header's own. */
export type ProtectorUnlockMethodId = "recovery" | "age" | "agePasskey";

/** Every id the unlock screen's tabs can carry. */
export type UnlockTabId =
  | "password"
  | "passkey"
  | "pin"
  | ProtectorUnlockMethodId;

const PROTECTOR_METHODS: readonly ProtectorUnlockMethodId[] = [
  "agePasskey",
  "age",
  "recovery",
];

export function isProtectorUnlockMethod(
  id: string,
): id is ProtectorUnlockMethodId {
  return PROTECTOR_METHODS.some((method) => method === id);
}

/** The tab a manifest-only capsule opens through, or null when none. */
export function capsuleTabOf(
  record: Pick<ProtectionRecord, "kind"> & {
    legacy?: boolean;
    proofStatus?: ProtectionRecord["proofStatus"];
  },
): UnlockTabId | null {
  if (record.proofStatus !== "verified") return null;
  switch (record.kind) {
    case "recovery-key":
      return "recovery";
    case "age-recipient":
      return "age";
    case "age-webauthn":
      return "agePasskey";
    case "webauthn-prf":
      return record.legacy === true ? null : "passkey";
    default:
      return null;
  }
}

function manifestRecords(
  header: VaultHeader | null | undefined,
): readonly ProtectionRecord[] {
  const records = header?.protection?.records;
  return Array.isArray(records) ? records : [];
}

/** The records one protector tab can open, in manifest order. */
export function capsuleRecordsFor(
  header: VaultHeader | null | undefined,
  tab: UnlockTabId,
): ProtectionRecord[] {
  return manifestRecords(header).filter(
    (record) => capsuleTabOf(record) === tab,
  );
}

/**
 * The tabs the manifest's capsules add. `passkey` appears here only for a
 * passkey capsule: the header's own passkey wrap is listed with the others.
 */
export function listProtectorUnlockTabs(
  header: VaultHeader | null | undefined,
): UnlockTabId[] {
  const present = new Set<UnlockTabId>();
  for (const record of manifestRecords(header)) {
    const tab = capsuleTabOf(record);
    if (tab) present.add(tab);
  }
  const order: UnlockTabId[] = ["passkey", ...PROTECTOR_METHODS];
  return order.filter((tab) => present.has(tab));
}
