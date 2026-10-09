/**
 * Open a tomb's sealed body and hold it to the rollback witness in its header.
 *
 * Split out of `store.ts`: the store decides when to read the body; this file
 * decides whether what it found may be trusted.
 */

import { isJsonObject } from "@opensesame/os-domain";
import {
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  emptyBody,
  normalizeVaultBody,
  openJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { BODY_PATH, readSealedFile, vfsSeams } from "../vfs.js";
import { retireLegacySample } from "./body-edits.js";

const ROLLED_BACK =
  "this vault file is older than the last write recorded on this device. " +
  "If you restored a backup, import it from Settings instead; " +
  "the vault here was not opened, so nothing has been lost yet";

/** What a body carries beyond its items and folders, as it was sealed. */
function syncedFields(body: VaultBody): Partial<VaultBody> {
  return {
    ...(body.itemTypes !== undefined
      ? { itemTypes: body.itemTypes }
      : undefined),
    ...(body.itemTypesAt !== undefined
      ? { itemTypesAt: body.itemTypesAt }
      : undefined),
    ...(body.tombstones !== undefined
      ? { tombstones: body.tombstones }
      : undefined),
    // `null` or anything but an object is no key: it is not carried on.
    ...(isJsonObject(body.deviceIdentityKey)
      ? { deviceIdentityKey: body.deviceIdentityKey }
      : undefined),
    ...(body.masterWrap !== undefined
      ? { masterWrap: body.masterWrap }
      : undefined),
  };
}

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
  // A store that keeps each secret as its own file puts the body together now.
  await vfsSeams.openBody?.(tomb, vaultKey);
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
    const opened: VaultBody = {
      v: 1,
      items: body.items ?? [],
      folders: body.folders ?? [],
      ...syncedFields(body),
      rev,
    };
    // What the retired sample-data feature wrote is not shown, exported or
    // synced: it leaves the open body here and the next write drops it from
    // the sealed file, tombstoned so a device that still holds it cannot
    // bring it back.
    retireLegacySample(opened);
    // A body written before ADR 0172 holds `login` items: they are accounts
    // from here on, and the next write seals them as such.
    return normalizeVaultBody(opened);
  } catch (error) {
    throw error instanceof VaultCorruptError
      ? error
      : new VaultCorruptError("unreadable body");
  }
}
