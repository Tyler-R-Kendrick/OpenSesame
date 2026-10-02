/**
 * The encrypted offline backup as a file a person keeps (`backup.local-
 * encrypted`): the vault's wrapping header and its sealed body in vault-
 * core's offline-backup envelope — ciphertext only. The enrolled unlock
 * still opens it: the master password, the passkey, or the PIN.
 * `opensesame-id vault verify <file>` opens a password backup, and the
 * vault's Import key reads any of the three back (`sealedVaultText`).
 *
 * The body is read from storage as it was sealed, so an export never holds
 * a plaintext item. A restore is the store's own `importSealed`.
 */
import {
  type BoundaryValue,
  isJsonObject,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import {
  OFFLINE_BACKUP_FORMAT,
  type SealedBlob,
  VAULT_EXPORT_FORMAT,
  type VaultHeader,
  readVaultFile,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { BODY_PATH, PERSONAL_TOMB, readSealedFile } from "../vfs.js";
import {
  buildOfflineBackup,
  serializeOfflineBackup,
} from "./offline-backup.js";
import { unwrapVaultKeyWithPin } from "./unlock-methods.js";

const NO_MASTER_PASSWORD =
  "That export has no master-password unlock. Re-export from a vault that still has a password enrolled, or unlock the source vault and merge items another way.";

/** Which enrolled unlock opens an exported header. Password wins when present. */
export type ExportUnlock = "password" | "passkey" | "pin";

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

/** The unlock an export can be opened with, or null when nothing enrolled can. */
export function exportUnlockKind(
  header: VaultHeader | null | undefined,
): ExportUnlock | null {
  if (!header) return null;
  if (header.wrap && header.kdf) return "password";
  const unlocks = header.unlocks;
  if (unlocks?.passkey || (unlocks?.passkeys?.length ?? 0) > 0) {
    return "passkey";
  }
  if (unlocks?.pin) return "pin";
  return null;
}

/** The sheet's "Opens with" fact for an enrolled unlock. */
export function exportOpener(
  header: VaultHeader | null | undefined,
): string | null {
  const kind = exportUnlockKind(header);
  if (kind === "password") return "the master password";
  if (kind === "passkey") return "the passkey";
  if (kind === "pin") return "the PIN";
  return null;
}

/** The unlock named by a sealed export's header, for the import sheet. */
export function sealedExportUnlock(text: string): ExportUnlock | null {
  try {
    const parsed = overlapCast<unknown, { header?: VaultHeader }>(
      JSON.parse(text),
    );
    return exportUnlockKind(parsed.header);
  } catch {
    return null;
  }
}

/**
 * Unwrap a sealed export. A string is the password, or the PIN when that is
 * the only wrap. A passkey file needs the ceremony's raw vault key instead.
 */
export async function unwrapExportedVaultKey(
  header: VaultHeader,
  secret: string | Uint8Array,
): Promise<Uint8Array> {
  if (secret instanceof Uint8Array) return secret;
  const kind = exportUnlockKind(header);
  if (kind === "password") {
    return unwrapRawVaultKeyFromPassword(header, secret);
  }
  if (kind === "pin" && header.unlocks?.pin) {
    return unwrapVaultKeyWithPin(header.unlocks.pin, secret);
  }
  if (kind === "passkey") {
    throw new Error("This backup opens with its passkey.");
  }
  throw new Error(NO_MASTER_PASSWORD);
}

/**
 * Why this vault cannot be exported now, or null when it can. A backup
 * nobody could open is not offered: password, passkey, or PIN, whichever
 * is enrolled.
 */
export function exportRefusal(vault: BackupSource): string | null {
  if (vault.status !== "unlocked") return "Unlock to export";
  if (vault.guest) return "A guest vault is not exported";
  if (!vault.header) return "Nothing sealed to export yet";
  if (exportUnlockKind(vault.header) === null) {
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
