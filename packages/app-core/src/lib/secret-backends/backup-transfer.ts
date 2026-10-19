/** Explicit ciphertext backup and restore through the same configured secret backend. */
import {
  MAX_OFFLINE_BACKUP_BYTES,
  buildOfflineBackupEnvelope,
  readVaultFile,
  serializeOfflineBackupEnvelope,
} from "@opensesame/vault-core";
import {
  exportRefusal,
  sealedVaultText,
} from "../vault/offline-backup-file.js";
import type { VaultStore } from "../vault/store.js";
import { localVaultSessionGuard } from "./local-vault-port.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemSummary,
  type SecretBackendSession,
} from "./types.js";

export type VaultBackupPort = Pick<
  VaultStore,
  | "getSnapshot"
  | "onLock"
  | "flushPendingWrites"
  | "exportSealed"
  | "importSealed"
>;
export type SecretBackendBackupHandle = {
  backend: SecretBackend;
  session: SecretBackendSession;
};

function backupOperation(
  open: SecretBackendBackupHandle,
  assertCurrent?: () => void,
) {
  const backendSignal = open.backend.signal;
  const sessionSignal = open.session.signal;
  return () => {
    assertCurrent?.();
    if (backendSignal?.aborted || sessionSignal?.aborted)
      throw new SecretBackendError(
        "stale",
        "The secret backend backup session ended.",
      );
  };
}

async function backupPort(
  provided?: VaultBackupPort,
): Promise<VaultBackupPort> {
  return provided ?? (await import("../vault/store.js")).vaultStore;
}
function checkDestination(port: VaultBackupPort): void {
  if (port.getSnapshot().guest)
    throw new SecretBackendError(
      "unsupported",
      "A guest vault cannot be backed up or restored through a secret backend.",
    );
}
function ciphertextEnvelope(exported: string): string {
  if (exported.length > MAX_OFFLINE_BACKUP_BYTES)
    throw new SecretBackendError(
      "response",
      "That vault backup is larger than 64 MB.",
    );
  const sealed = readVaultFile(exported);
  return serializeOfflineBackupEnvelope(
    buildOfflineBackupEnvelope({
      header: sealed.header,
      body: sealed.body,
      projectId: sealed.tomb === "personal" ? null : sealed.tomb,
    }),
  );
}
function backupText(item: SecretBackendItem): string {
  const candidates = new Set<string>();
  for (const text of [item.notes, item.secret]) {
    if (!text.trimStart().startsWith("{")) continue;
    try {
      candidates.add(sealedVaultText(ciphertextEnvelope(text)));
    } catch {
      /* A generic secret or note is not a sealed vault backup. */
    }
  }
  if (candidates.size > 1)
    throw new SecretBackendError(
      "ambiguous",
      "This item contains different backups in its notes and secret. Choose a single backup item.",
    );
  const result = candidates.values().next().value;
  if (!result)
    throw new SecretBackendError(
      "response",
      "That item does not contain a valid ciphertext vault backup.",
    );
  return result;
}

/** The source's enrolled unlock protects the payload; no unlock password is uploaded. */
export async function backUpVaultToSecretBackend(
  open: SecretBackendBackupHandle,
  name: string,
  provided?: VaultBackupPort,
  assertCurrent?: () => void,
): Promise<SecretBackendItemSummary> {
  const descriptor = open.backend.capabilities.vaultBackup;
  if (
    !descriptor ||
    !open.backend.capabilities.create ||
    !open.backend.capabilities.get ||
    !open.backend.createItem
  )
    throw new SecretBackendError(
      "unsupported",
      "This connection cannot store and verify a vault backup.",
    );
  if (!name.trim())
    throw new SecretBackendError("configuration", "Enter a backup item name.");
  const operation = backupOperation(open, assertCurrent);
  operation();
  const port = await backupPort(provided);
  operation();
  const guard = localVaultSessionGuard(port);
  const check = () => {
    operation();
    return guard.current();
  };
  try {
    checkDestination(port);
    check();
    await port.flushPendingWrites();
    const snapshot = check();
    const refusal = exportRefusal(snapshot);
    if (refusal) throw new SecretBackendError("configuration", refusal);
    const exported = port.exportSealed();
    if (readVaultFile(exported).tomb !== snapshot.tomb)
      throw new SecretBackendError("stale", "The vault backup source changed.");
    const ciphertext = ciphertextEnvelope(exported);
    if (
      descriptor.maxBytes !== undefined &&
      new TextEncoder().encode(ciphertext).length > descriptor.maxBytes
    )
      throw new SecretBackendError(
        "unsupported",
        "This vault backup exceeds the destination's item size limit. Choose a backend with a larger note or secret field.",
      );
    check();
    const created = await open.backend.createItem(
      {
        name: name.trim(),
        kind: descriptor.kind,
        notes: descriptor.field === "notes" ? ciphertext : "",
        secret:
          descriptor.field === "secret"
            ? ciphertext
            : descriptor.kind === "login"
              ? `Aa1!${crypto.randomUUID().replaceAll("-", "")}`
              : "",
      },
      open.session,
    );
    check();
    const stored = await open.backend.getItem(created.id, open.session);
    check();
    if (stored.id !== created.id || stored[descriptor.field] !== ciphertext)
      throw new SecretBackendError(
        "response",
        "The destination did not preserve the complete encrypted backup. Backup verification failed.",
      );
    return { id: stored.id, name: stored.name, kind: stored.kind };
  } finally {
    guard.close();
  }
}

/** Restore merges through the real vault importer, preserving this vault's identity and existing items. */
export async function restoreVaultFromSecretBackend(
  open: SecretBackendBackupHandle,
  reference: string,
  secret: string | Uint8Array,
  provided?: VaultBackupPort,
  assertCurrent?: () => void,
): Promise<number> {
  if (!open.backend.capabilities.get)
    throw new SecretBackendError(
      "unsupported",
      "This connection cannot read a vault backup.",
    );
  if (!reference.trim())
    throw new SecretBackendError(
      "configuration",
      "Enter the backup item's name or ID.",
    );
  const operation = backupOperation(open, assertCurrent);
  operation();
  const port = await backupPort(provided);
  operation();
  const guard = localVaultSessionGuard(port);
  const check = () => {
    operation();
    return guard.current();
  };
  const unlock = secret instanceof Uint8Array ? secret.slice() : secret;
  try {
    checkDestination(port);
    check();
    const item = await open.backend.getItem(reference, open.session);
    check();
    const count = await port.importSealed(backupText(item), unlock, {
      adoptIdentity: false,
      assertCurrent: check,
    });
    check();
    await port.flushPendingWrites();
    check();
    return count;
  } finally {
    if (unlock instanceof Uint8Array) unlock.fill(0);
    guard.close();
  }
}
