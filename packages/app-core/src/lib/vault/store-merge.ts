/**
 * Open another device's sealed snapshot of the unlocked vault (ADR 0144).
 *
 * Split out of `store.ts`: the store decides when to merge; this file decides
 * whether what arrived is this vault at all. A snapshot opens only under this
 * vault's key and only with the path binding of the tomb it was sealed in, so
 * a drive can withhold or replay a snapshot but never forge or alter one.
 */

import type { JsonObject } from "@opensesame/os-domain";
import {
  type SealedBlob,
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  deviceKeyTimeBounds,
  mergeVaultBodies,
  normalizeVaultBody,
  openJson,
  sameVaultContent,
  syncInstalledTypes,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { BODY_PATH } from "../vfs.js";
import { adoptMerged } from "./body-edits.js";
import { type VaultBodyPort, levelDeviceKey } from "./store-device-key.js";

/** What a device reads back from a drive before merging. */
export type DriveSnapshotInput = {
  /** The tomb the body was sealed in, which its seal binding names. */
  tomb: string;
  createdAt: string;
  body: SealedBlob;
  rev: number;
};

/** What a device hands a drive: its tomb, header and sealed body as stored. */
export type SealedSnapshot = {
  tomb: string;
  header: VaultHeader;
  body: SealedBlob;
  rev: number;
};

export type SnapshotMerge = {
  /** This device's body changed and was sealed again. */
  localChanged: boolean;
  /** The snapshot lacks something this device holds, so it should be replaced. */
  remoteBehind: boolean;
};

export async function openSnapshotBody(
  vaultKey: CryptoKey,
  header: VaultHeader,
  input: DriveSnapshotInput,
): Promise<VaultBody> {
  if (input.createdAt !== header.createdAt) {
    throw new VaultCorruptError("that snapshot belongs to another vault");
  }
  if (!input.body.ivB64 || !input.body.ctB64) {
    throw new VaultCorruptError("that snapshot has no sealed body");
  }
  const body = await openJson<VaultBody>(
    vaultKey,
    input.body,
    vaultSealBinding(input.tomb, BODY_PATH),
  );
  if (
    body.v !== 1 ||
    !Array.isArray(body.items) ||
    !Array.isArray(body.folders)
  ) {
    throw new VaultCorruptError("that snapshot's body is malformed");
  }
  if ((body.rev ?? 0) !== input.rev) {
    throw new VaultCorruptError(
      "that snapshot's revision does not match its body",
    );
  }
  // Another device may not have opened its vault since ADR 0172.
  return normalizeVaultBody(body);
}

/** `body` with `key` as its device identity key, or none. */
function withKey(body: VaultBody, key: JsonObject | undefined): VaultBody {
  const { deviceIdentityKey: _held, ...rest } = body;
  return key === undefined ? rest : { ...rest, deviceIdentityKey: key };
}

/**
 * Merge another device's sealed snapshot of this vault (ADR 0144). Reports
 * whether this device changed and whether the snapshot is now behind it.
 *
 * The one place two device identity keys are ranked from bodies (ADR 0160
 * §5a): the snapshot opened under this vault's own key and its `createdAt`
 * matched the header, so it is a device's own. Each side's key is vetted
 * first, so a forged or malformed record is dropped rather than outranked and
 * a merge never keeps it, and the key is written and levelled with the tomb's
 * in one step under the identity lock.
 */
export async function mergeSnapshotInto(
  port: VaultBodyPort,
  vaultKey: CryptoKey,
  header: VaultHeader,
  input: DriveSnapshotInput,
): Promise<SnapshotMerge> {
  const incoming = await openSnapshotBody(vaultKey, header, input);
  const { vettedField } = await import("../device-identity-trust.js");
  const bounds = deviceKeyTimeBounds(header.createdAt);
  const ownRaw = port.body().deviceIdentityKey;
  const own = await vettedField(ownRaw, bounds);
  const theirs = withKey(
    incoming,
    await vettedField(incoming.deviceIdentityKey, bounds),
  );
  let merged = mergeVaultBodies(withKey(port.body(), own), theirs);
  const localChanged = !sameVaultContent(merged, port.body());
  if (localChanged) {
    const { withDeviceIdentityFence } = await import(
      "../device-identity-key.js"
    );
    await withDeviceIdentityFence(port.tomb(), async () => {
      // Merged again inside the write chain, so an edit that landed meanwhile
      // is part of what gets sealed rather than overwritten by it.
      await port.mutate((body) => {
        const mine =
          body.deviceIdentityKey === ownRaw ? own : body.deviceIdentityKey;
        merged = mergeVaultBodies(withKey(body, mine), theirs);
        adoptMerged(body, merged);
      });
      // A type installed on another device arrives with this merge; rebuilding
      // the registry here is what makes it live without a re-unlock (ADR 0087 §7).
      syncInstalledTypes(port.body().itemTypes);
      // Another device's identity key may have come with it.
      await levelDeviceKey(port, { held: true });
    });
  }
  return { localChanged, remoteBehind: !sameVaultContent(merged, theirs) };
}
