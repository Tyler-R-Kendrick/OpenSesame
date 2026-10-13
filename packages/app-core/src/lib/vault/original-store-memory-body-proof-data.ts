/** Actual current Root/policy/BODY proof only; private Store retains all state and adoption. */
import type { VaultBody, VaultHeader } from "@opensesame/vault-core";
import { BODY_PATH, readSealedFile } from "../vfs.js";
import { verifyOriginalUnlockPolicy } from "./original-unlock-policy-proof.js";
import { proveVaultBodyBeforeFactors } from "./store-body.js";
import { readTombHeader } from "./store-header.js";

type ExistingRootData = Readonly<{
  key: CryptoKey | null;
  raw: Uint8Array | null;
  header: VaultHeader | null;
}>;
function outerPolicy(header: VaultHeader): string {
  const { protection: _manifest, bodyRev: _witness, ...policy } = header;
  return JSON.stringify(policy);
}
function refuse(): never {
  throw new Error("The current vault policy changed before its memory write.");
}
function originalMemoryRootChanged(
  before: NonNullable<VaultHeader["protection"]>,
  next: VaultHeader["protection"],
): boolean {
  return (
    !next ||
    before.vaultId !== next.vaultId ||
    before.rootKeyId !== next.rootKeyId ||
    before.rootEpoch !== next.rootEpoch ||
    before.purpose !== next.purpose ||
    next.revision < before.revision
  );
}
/** Called only inside the fixed writer's accepted lifetime, before its private mutation callback. */
export async function proveOriginalStoreMemoryBodyData(
  tomb: string,
  held: ExistingRootData,
  original: () => void,
): Promise<VaultBody> {
  original();
  const { key, header: previous } = held;
  if (!key || !previous) refuse();
  const root = held.raw?.slice();
  try {
    const current = readTombHeader(tomb);
    if (
      !current ||
      outerPolicy(current) !== outerPolicy(previous) ||
      (current.bodyRev ?? 0) < (previous.bodyRev ?? 0)
    )
      refuse();
    // A same-Root peer may publish its authenticated projection. It may never
    // silently replace this original's Root identity or configured outer gates.
    const before = previous.protection;
    const next = current.protection;
    if (before && originalMemoryRootChanged(before, next)) refuse();
    const headerWire = JSON.stringify(current);
    const bodyWire = JSON.stringify(readSealedFile(tomb, BODY_PATH));
    await verifyOriginalUnlockPolicy(current, root, original);
    original();
    // Always authenticate the real current bound BODY, including a same-IV
    // mirror; the original cache mark supplies no proof here.
    const body = await proveVaultBodyBeforeFactors(tomb, key, current);
    original();
    if (
      JSON.stringify(readTombHeader(tomb)) !== headerWire ||
      JSON.stringify(readSealedFile(tomb, BODY_PATH)) !== bodyWire
    )
      refuse();
    return body;
  } finally {
    root?.fill(0);
  }
}
