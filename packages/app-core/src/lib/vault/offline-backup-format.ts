import {
  type BoundaryObject,
  type BoundaryValue,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Offline encrypted vault / sync-blob backup.
 *
 * # Threat model
 *
 * The backup file is **as sensitive as the vault**. It is an envelope of
 * already-sealed ciphertext (vault header + AES-GCM body, optional sync
 * blobs). Host never sees the vault recovery / unlock key. Anyone with the
 * file still needs the master password (or enrolled unlock) to open it.
 * Protect the file at rest on disk like a password database export.
 *
 * Never upload plaintext backups to Host. Never wrap with the Host deployment
 * / connection seal key (`OPENSESAME_CONNECTION_KEY`) — wrapping stays on the
 * device under the vault unlock key already baked into `header.wrap`.
 */

import type { SealedBlob, VaultHeader } from "./crypto.js";

export const OFFLINE_BACKUP_FORMAT = "opensesame-offline-backup" as const;
export const OFFLINE_BACKUP_VERSION = 1 as const;
export const MAX_OFFLINE_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_SYNC_BLOBS = 4096;

export type SyncBlobCiphertext = {
  id: string;
  epoch: number;
  /** Base64 opaque ciphertext — never plaintext. */
  ciphertextB64: string;
};

export type OfflineBackupEnvelope = {
  format: typeof OFFLINE_BACKUP_FORMAT;
  v: typeof OFFLINE_BACKUP_VERSION;
  projectId: string | null;
  exportedAt: string;
  /** Ciphertext vault export — header is public params; body is sealed. */
  vault: {
    header: VaultHeader;
    body: SealedBlob;
  };
  /** Optional Host-sync opaque blobs (ciphertext only). */
  syncBlobs: SyncBlobCiphertext[];
  /** Explicitly records that deployment seal was not used. */
  deploymentSealUsed: false;
};

const FORBIDDEN_SUBSTRINGS = [
  '"plaintext"',
  '"password":',
  '"secret":',
  '"token":',
  "OPENSESAME_CONNECTION_KEY",
  "deployment_seal",
] as const;

/** Refuse envelopes that smuggle plaintext or claim a deployment seal wrap. */
export function assertCiphertextOnlyBackupJson(json: string): void {
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (json.includes(needle)) {
      throw new Error(
        "refusing backup JSON with plaintext or deployment-seal fields",
      );
    }
  }
}

export function refuseDeploymentSealWrap(label: string): void {
  const lower = label.toLowerCase();
  if (
    lower.includes("connection_key") ||
    lower.includes("deployment_seal") ||
    lower.includes("opensesame_connection") ||
    lower.includes("broker_seal")
  ) {
    throw new Error("deployment seal key must never wrap offline backups");
  }
}

export function buildOfflineBackupEnvelope(input: {
  projectId?: string | null;
  header: VaultHeader;
  body: SealedBlob;
  syncBlobs?: SyncBlobCiphertext[];
  exportedAt?: string;
}): OfflineBackupEnvelope {
  refuseDeploymentSealWrap("device-vault-unlock");
  if (!input.header || !input.body?.ivB64 || !input.body?.ctB64) {
    throw new Error("offline backup requires sealed vault header and body");
  }
  const envelope: OfflineBackupEnvelope = {
    format: OFFLINE_BACKUP_FORMAT,
    v: OFFLINE_BACKUP_VERSION,
    projectId: input.projectId ?? null,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    vault: {
      header: input.header,
      body: input.body,
    },
    syncBlobs: (input.syncBlobs ?? []).map((blob) => ({
      id: blob.id,
      epoch: blob.epoch,
      ciphertextB64: blob.ciphertextB64,
    })),
    deploymentSealUsed: false,
  };
  assertCiphertextOnlyBackupJson(JSON.stringify(envelope));
  return envelope;
}

export function serializeOfflineBackupEnvelope(
  envelope: OfflineBackupEnvelope,
): string {
  if (envelope.deploymentSealUsed !== false) {
    throw new Error("offline backup must not use deployment seal");
  }
  const json = `${JSON.stringify(envelope, null, 2)}\n`;
  assertCiphertextOnlyBackupJson(json);
  return json;
}

/** `value` as a plain object, or `message` thrown. */
function objectOr(value: BoundaryValue, message: string): BoundaryObject {
  if (!isTypeofObject(value) || value === null || Array.isArray(value))
    throw new Error(message);
  return overlapCast(value);
}

/** The envelope's top level: size, JSON, format, version, no deployment seal. */
function readEnvelopeRow(fileText: string): BoundaryObject {
  if (fileText.length > MAX_OFFLINE_BACKUP_BYTES) {
    throw new Error("That offline backup is larger than 64 MB.");
  }
  assertCiphertextOnlyBackupJson(fileText);
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  const row = objectOr(
    parsed,
    "That file is not an OpenSesame offline backup.",
  );
  if (
    row.format !== OFFLINE_BACKUP_FORMAT ||
    row.v !== OFFLINE_BACKUP_VERSION
  ) {
    throw new Error("That file is not an OpenSesame offline backup.");
  }
  if (row.deploymentSealUsed !== false) {
    throw new Error("That backup claims a deployment seal wrap — refused.");
  }
  return row;
}

const MISSING_VAULT = "That backup is missing sealed vault ciphertext.";

function readVaultCiphertext(
  value: BoundaryValue,
): OfflineBackupEnvelope["vault"] {
  const vault = objectOr(value, MISSING_VAULT);
  if (!vault.header) throw new Error(MISSING_VAULT);
  const body = objectOr(vault.body, MISSING_VAULT);
  if (!isString(body.ivB64) || !isString(body.ctB64))
    throw new Error(MISSING_VAULT);
  const header: VaultHeader = overlapCast(vault.header);
  return { header, body: { ivB64: body.ivB64, ctB64: body.ctB64 } };
}

function readSyncBlob(value: BoundaryValue): SyncBlobCiphertext {
  const blob = objectOr(value, "That backup has a malformed sync blob.");
  if (
    !isString(blob.id) ||
    !isNumber(blob.epoch) ||
    !isString(blob.ciphertextB64) ||
    !blob.ciphertextB64
  ) {
    throw new Error("That backup has a malformed sync blob.");
  }
  return { id: blob.id, epoch: blob.epoch, ciphertextB64: blob.ciphertextB64 };
}

function readSyncBlobs(value: BoundaryValue): SyncBlobCiphertext[] {
  const raw = Array.isArray(value) ? value : [];
  if (raw.length > MAX_SYNC_BLOBS) {
    throw new Error("That backup has too many sync blobs.");
  }
  let syncBytes = 0;
  return raw.map((entry) => {
    const blob = readSyncBlob(entry);
    syncBytes += blob.ciphertextB64.length;
    if (syncBytes > MAX_OFFLINE_BACKUP_BYTES) {
      throw new Error("That backup's sync ciphertext is larger than 64 MB.");
    }
    return blob;
  });
}

export function parseOfflineBackupEnvelope(
  fileText: string,
): OfflineBackupEnvelope {
  const row = readEnvelopeRow(fileText);
  return {
    format: OFFLINE_BACKUP_FORMAT,
    v: OFFLINE_BACKUP_VERSION,
    projectId: isString(row.projectId) ? row.projectId : null,
    exportedAt: isString(row.exportedAt)
      ? row.exportedAt
      : new Date().toISOString(),
    vault: readVaultCiphertext(row.vault),
    syncBlobs: readSyncBlobs(row.syncBlobs),
    deploymentSealUsed: false,
  };
}
