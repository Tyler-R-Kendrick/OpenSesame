/**
 * What a device hands a tailnet drive (ADR 0140): the vault's sealed body and
 * a portable copy of its header, and nothing else.
 *
 * The drive is dumb storage in the Enpass sense — it keeps the newest snapshot
 * and never holds a key. The header travels only so a second device can adopt
 * the vault, and only the wraps that are safe off the device go with it: the
 * master-password wrap (a 600k-round PBKDF2 over a policy-checked password)
 * and passkey PRF wraps (no secret to guess). The PIN wrap stays home, because
 * a short PIN under PBKDF2 is guessable by whoever holds the file, and so does
 * the password hint, which is plaintext about the password.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type {
  SealedBlob,
  VaultHeader,
  VaultUnlocks,
} from "@opensesame/vault-core";
import type {
  DriveSnapshotInput,
  SealedSnapshot,
} from "../vault/store-merge.js";

export const DRIVE_SNAPSHOT_FORMAT = "opensesame-vault-drive-snapshot";

export type DriveSnapshot = {
  format: typeof DRIVE_SNAPSHOT_FORMAT;
  v: 1;
  tomb: string;
  header: VaultHeader;
  body: SealedBlob;
  rev: number;
};

/** The header a second device may adopt: no PIN wrap, no hint, no device manifest. */
export function portableHeader(header: VaultHeader, rev: number): VaultHeader {
  const unlocks = portableUnlocks(header.unlocks);
  return {
    v: 1,
    createdAt: header.createdAt,
    ...(header.kdf && header.wrap
      ? { kdf: header.kdf, wrap: header.wrap }
      : undefined),
    ...(unlocks ? { unlocks } : undefined),
    bodyRev: rev,
  };
}

function portableUnlocks(
  unlocks: VaultUnlocks | undefined,
): VaultUnlocks | undefined {
  if (!unlocks) return undefined;
  const { pin: _stays, ...rest } = unlocks;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** True when a portable header still carries a way in that works off this device. */
export function adoptable(header: VaultHeader): boolean {
  const passkeys =
    (header.unlocks?.passkeys?.length ?? 0) > 0 ||
    header.unlocks?.passkey !== undefined;
  return (header.kdf !== undefined && header.wrap !== undefined) || passkeys;
}

export function buildDriveSnapshot(sealed: SealedSnapshot): DriveSnapshot {
  return {
    format: DRIVE_SNAPSHOT_FORMAT,
    v: 1,
    tomb: sealed.tomb,
    header: portableHeader(sealed.header, sealed.rev),
    body: sealed.body,
    rev: sealed.rev,
  };
}

function isSealedBlob(value: BoundaryValue): value is SealedBlob {
  return (
    isJsonObject(value) &&
    isString(value.ivB64) &&
    isString(value.ctB64) &&
    value.ivB64.length > 0 &&
    value.ctB64.length > 0
  );
}

/**
 * Read a snapshot a drive returned. Anything else is refused whole: a drive is
 * untrusted storage, and the body's seal is checked again when it is merged.
 */
export function parseDriveSnapshot(value: BoundaryValue): DriveSnapshot {
  if (
    !isJsonObject(value) ||
    value.format !== DRIVE_SNAPSHOT_FORMAT ||
    value.v !== 1 ||
    !isString(value.tomb) ||
    !isNumber(value.rev) ||
    !Number.isSafeInteger(value.rev) ||
    value.rev < 0 ||
    !isSealedBlob(value.body) ||
    !isJsonObject(value.header) ||
    value.header.v !== 1 ||
    !isString(value.header.createdAt)
  ) {
    throw new Error("The drive holds something that is not a vault snapshot.");
  }
  return {
    format: DRIVE_SNAPSHOT_FORMAT,
    v: 1,
    tomb: value.tomb,
    header: overlapCast(value.header),
    body: { ivB64: value.body.ivB64, ctB64: value.body.ctB64 },
    rev: value.rev,
  };
}

export function snapshotInput(snapshot: DriveSnapshot): DriveSnapshotInput {
  return {
    tomb: snapshot.tomb,
    createdAt: snapshot.header.createdAt,
    body: snapshot.body,
    rev: snapshot.rev,
  };
}
