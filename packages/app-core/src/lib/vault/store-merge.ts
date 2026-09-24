/**
 * Open another device's sealed snapshot of the unlocked vault (ADR 0143).
 *
 * Split out of `store.ts`: the store decides when to merge; this file decides
 * whether what arrived is this vault at all. A snapshot opens only under this
 * vault's key and only with the path binding of the tomb it was sealed in, so
 * a drive can withhold or replay a snapshot but never forge or alter one.
 */

import {
  type SealedBlob,
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  openJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { BODY_PATH } from "../vfs.js";

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
  return body;
}
