/**
 * The encrypted offline backup as a file a person keeps (`backup.local-
 * encrypted`): the vault's wrapping header and its sealed body in vault-
 * core's offline-backup envelope — ciphertext only, the master password
 * still the key. `opensesame-id vault verify <file>` opens what this writes,
 * and the vault's Import key reads it back (`sealedVaultText`).
 *
 * Nothing here decrypts. The body is read from storage as it was sealed, so
 * an export never holds a plaintext item, and a restore is the store's own
 * `importSealed` with the password the person types.
 */
import {
  type BoundaryValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import {
  OFFLINE_BACKUP_FORMAT,
  type SealedBlob,
  VAULT_EXPORT_FORMAT,
  type VaultHeader,
  readVaultFile,
} from "@opensesame/vault-core";
import { BODY_PATH, PERSONAL_TOMB, readSealedFile } from "../vfs.js";
import {
  buildOfflineBackup,
  serializeOfflineBackup,
} from "./offline-backup.js";

/** What the export reads of the vault's state. */
export type BackupSource = Readonly<{
  status: string;
  guest: boolean;
  tomb: string;
  header: VaultHeader | null;
}>;

export type BackupFile = Readonly<{ fileName: string; text: string }>;

export const offlineBackupFileSeams = {
  readBody: (tomb: string): SealedBlob | null =>
    readSealedFile(tomb, BODY_PATH),
  now: (): Date => new Date(),
};

/**
 * Why this vault cannot be exported now, or null when it can. A backup
 * nobody could open is not offered: the restore and `vault verify` both
 * unwrap with the master password, so a vault without one has no backup to
 * give yet.
 */
export function exportRefusal(vault: BackupSource): string | null {
  if (vault.status !== "unlocked") return "Unlock to export";
  if (vault.guest) return "A guest vault is not exported";
  if (!vault.header) return "Nothing sealed to export yet";
  if (!vault.header.wrap || !vault.header.kdf) {
    return "Export needs a master password";
  }
  return null;
}

/** `opensesame-offline-backup-2026-09-27.json`, or with the tomb for a project. */
export function backupFileName(tomb: string, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  const scope = tomb === PERSONAL_TOMB ? "" : `-${tomb.slice(0, 8)}`;
  return `opensesame-offline-backup${scope}-${day}.json`;
}

/** The backup file, built from what is sealed on disk. Throws its refusal. */
export function offlineBackupFile(vault: BackupSource): BackupFile {
  const refusal = exportRefusal(vault);
  if (refusal !== null) throw new Error(refusal);
  const header = vault.header;
  const body = offlineBackupFileSeams.readBody(vault.tomb);
  if (!header || !body) throw new Error("Nothing sealed to export yet");
  const at = offlineBackupFileSeams.now();
  const envelope = buildOfflineBackup({
    projectId: vault.tomb === PERSONAL_TOMB ? null : vault.tomb,
    header,
    body,
    exportedAt: at.toISOString(),
  });
  return {
    fileName: backupFileName(vault.tomb, at),
    text: serializeOfflineBackup(envelope),
  };
}

/** The format a parsed file names, when it is one of ours. */
export function vaultFileFormat(
  json: BoundaryValue,
): typeof OFFLINE_BACKUP_FORMAT | typeof VAULT_EXPORT_FORMAT | null {
  const format = isJsonObject(json) ? readString(json.format) : undefined;
  if (format === OFFLINE_BACKUP_FORMAT || format === VAULT_EXPORT_FORMAT) {
    return format;
  }
  return null;
}

/**
 * An OpenSesame backup or sealed export, rewritten as the sealed export the
 * store restores from (`VaultStore.importSealed`). Throws when the file
 * names our format but is not a readable one.
 */
export function sealedVaultText(text: string): string {
  const file = readVaultFile(text);
  return JSON.stringify({
    format: VAULT_EXPORT_FORMAT,
    v: 1,
    tomb: file.tomb,
    header: file.header,
    body: file.body,
  });
}
