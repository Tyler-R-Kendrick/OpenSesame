/**
 * Open a tomb's sealed body and hold it to the rollback witness in its header.
 *
 * Split out of `store.ts`: the store decides when to read the body; this file
 * decides whether what it found may be trusted.
 */

import {
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  emptyBody,
  openJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { BODY_PATH, readSealedFile } from "../vfs.js";

const ROLLED_BACK =
  "this vault file is older than the last write recorded on this device. " +
  "If you restored a backup, import it from Settings instead; " +
  "the vault here was not opened, so nothing has been lost yet";

/**
 * The body of `tomb`, opened with `vaultKey`. A missing body is an empty vault
 * only while the header records no write: once `bodyRev` says a body landed,
 * its absence is a deletion or a rollback, never a fresh start.
 */
export async function loadVaultBody(
  tomb: string,
  vaultKey: CryptoKey,
  header: VaultHeader | null,
): Promise<VaultBody> {
  const recorded = header?.bodyRev ?? 0;
  const sealed = readSealedFile(tomb, BODY_PATH);
  if (!sealed) {
    if (recorded > 0) {
      throw new VaultCorruptError(
        "this vault's contents are missing from this device, though its header records a write; the vault was not opened",
      );
    }
    return emptyBody();
  }
  try {
    const body = await openJson<VaultBody>(
      vaultKey,
      sealed,
      vaultSealBinding(tomb, BODY_PATH),
    );
    const rev = body.rev ?? 0;
    if (rev < recorded) throw new VaultCorruptError(ROLLED_BACK);
    return {
      v: 1,
      items: body.items ?? [],
      folders: body.folders ?? [],
      ...(body.itemTypes !== undefined
        ? { itemTypes: body.itemTypes }
        : undefined),
      ...(body.tombstones !== undefined
        ? { tombstones: body.tombstones }
        : undefined),
      rev,
    };
  } catch (error) {
    throw error instanceof VaultCorruptError
      ? error
      : new VaultCorruptError("unreadable body");
  }
}
