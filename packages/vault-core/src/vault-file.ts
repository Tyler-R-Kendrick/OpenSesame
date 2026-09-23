/**
 * A vault file opened offline (ADR 0133 §5–7): a sealed export
 * (`opensesame-vault-export`) or an offline backup
 * (`opensesame-offline-backup`), unwrapped with the master password and read
 * down to what may be shown — the tomb it belongs to, whether its body is
 * bound to that tomb, its revision, and each item's name, kind and path. No
 * field value leaves this module: this is what `opensesame-id vault verify`
 * and `vault ls` print, and what an isolate runs to prove the read path.
 */
import { isString, overlapCast } from "@opensesame/os-domain";
import {
  type SealedBlob,
  VaultCorruptError,
  type VaultHeader,
  importVaultKey,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "./crypto.js";
import type { VaultBody } from "./model.js";
import {
  OFFLINE_BACKUP_FORMAT,
  parseOfflineBackupEnvelope as parseOfflineBackup,
} from "./offline-backup-format.js";
import { openJsonForRebind } from "./seal-open.js";
import { buildRows } from "./tree-rows.js";

export const VAULT_EXPORT_FORMAT = "opensesame-vault-export";

export type VaultFileFormat =
  | typeof VAULT_EXPORT_FORMAT
  | typeof OFFLINE_BACKUP_FORMAT;

/** The sealed parts of a vault file, before any key is involved. */
export type SealedVaultFile = Readonly<{
  format: VaultFileFormat;
  tomb: string;
  header: VaultHeader;
  body: SealedBlob;
}>;

export type VaultFileEntry = Readonly<{
  id: string;
  name: string;
  kind: string;
  /** Where the vault tree lists it: `Folder/name.ext` or `name.ext`. */
  path: string;
}>;

/** A vault body opened with its key, and whether it is bound to its tomb. */
export type OpenedVaultBody = Readonly<{ body: VaultBody; bound: boolean }>;

export type OpenedVaultFile = Readonly<{
  format: VaultFileFormat;
  tomb: string;
  /** The body is sealed to this tomb (false: a legacy unbound body). */
  bound: boolean;
  rev: number | null;
  items: readonly VaultFileEntry[];
}>;

type ExportEnvelope = {
  format?: string;
  tomb?: string;
  header?: VaultHeader;
  body?: SealedBlob;
};

/** Parse either envelope; throws `VaultCorruptError` on anything else. */
export function readVaultFile(text: string): SealedVaultFile {
  let parsed: ExportEnvelope;
  try {
    parsed = overlapCast(JSON.parse(text));
  } catch {
    throw new VaultCorruptError("not a vault file");
  }
  if (parsed?.format === OFFLINE_BACKUP_FORMAT) {
    const backup = parseOfflineBackup(text);
    return {
      format: OFFLINE_BACKUP_FORMAT,
      tomb: backup.projectId ?? "personal",
      header: backup.vault.header,
      body: backup.vault.body,
    };
  }
  if (
    parsed?.format !== VAULT_EXPORT_FORMAT ||
    !isString(parsed.tomb) ||
    !parsed.header ||
    !parsed.body
  ) {
    throw new VaultCorruptError("not a vault file");
  }
  return {
    format: VAULT_EXPORT_FORMAT,
    tomb: parsed.tomb,
    header: parsed.header,
    body: parsed.body,
  };
}

/** Open the body with an already-unwrapped raw vault key. */
export async function openVaultBody(
  file: SealedVaultFile,
  rawKey: Uint8Array,
): Promise<OpenedVaultBody> {
  const key = await importVaultKey(rawKey);
  const opened = await openJsonForRebind<VaultBody>(
    key,
    file.body,
    vaultSealBinding(file.tomb, "body"),
  );
  return { body: opened.value, bound: !opened.rebound };
}

/** Names, kinds and paths — never a field value. */
export function summarizeVaultBody(
  file: SealedVaultFile,
  body: VaultBody,
  bound: boolean,
): OpenedVaultFile {
  const rows = buildRows(body.items, body.folders ?? [], new Set(), "");
  const paths = new Map<string, string>();
  for (const row of rows)
    if (row.type === "item") paths.set(row.item.id, row.path);
  return {
    format: file.format,
    tomb: file.tomb,
    bound,
    rev: body.rev ?? null,
    items: body.items.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      path: paths.get(item.id) ?? item.name,
    })),
  };
}

/**
 * Open a vault file with its master password. Throws `WrongPasswordError`
 * for the wrong password and `VaultCorruptError` for a damaged or foreign
 * file.
 */
export async function openVaultFile(
  text: string,
  password: string,
): Promise<OpenedVaultFile> {
  const file = readVaultFile(text);
  const raw = await unwrapRawVaultKeyFromPassword(file.header, password);
  const { body, bound } = await openVaultBody(file, raw);
  return summarizeVaultBody(file, body, bound);
}
