/** A generation refresh proves the actual common AES root; identifiers alone confer no authority. */
import {
  type BoundaryValue,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type RootProtectionManifest,
  importVaultKey,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { verifyManifestAuth } from "./vault/protection/manifest-auth.js";

export async function proveCommonStoredRoot(
  raw: Uint8Array,
  owner: CryptoKey,
  storage: CryptoKey,
  serialized: string | null,
  tomb: string,
  check: () => void,
): Promise<void> {
  check();
  if (!serialized) throw new Error("The authenticated root header is missing.");
  const header: BoundaryValue = JSON.parse(serialized);
  if (!isJsonObject(header) || !isJsonObject(header.protection))
    throw new Error("The root has no authenticated manifest.");
  const manifest: RootProtectionManifest = overlapCast(header.protection);
  await verifyManifestAuth(raw, manifest);
  check();
  const actual = await importVaultKey(raw);
  check();
  const binding = vaultSealBinding(tomb, "root-generation-proof");
  const proof = { nonce: crypto.randomUUID() };
  const sealed = await sealJson(actual, proof, binding);
  check();
  await openJson(owner, sealed, binding);
  check();
  await openJson(storage, sealed, binding);
  check();
}
