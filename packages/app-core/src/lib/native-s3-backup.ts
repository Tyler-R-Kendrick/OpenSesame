/** Explicit encrypted backup through a verified native S3 record; never a primary VFS. */
import { Effect, Redacted } from "effect";
import {
  type NativeS3BackupOptions,
  captureNativeS3Backup,
} from "./native-s3-backup-authority.js";
import { invalidateNativeS3 } from "./native-s3-state.js";
import type { SecretBackendBackupHandle } from "./secret-backends/backup-transfer.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
  type SecretBackendSession,
} from "./secret-backends/types.js";
import type { SecretFsError } from "./secret-fs/errors.js";
import { MAX_FILE_BYTES, makeS3SecretFiles } from "./secret-fs/s3.js";
import { sealedVaultText } from "./vault/offline-backup-file.js";

type Owner = Awaited<ReturnType<typeof captureNativeS3Backup>>;
function unsupported(): never {
  throw new SecretBackendError(
    "unsupported",
    "Open this saved S3 connection for explicit vault backup or restore.",
  );
}
function ciphertext(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_FILE_BYTES)
    throw new SecretBackendError(
      "unsupported",
      "This S3 backup exceeds 4 MiB.",
    );
  try {
    sealedVaultText(text);
  } catch {
    throw new SecretBackendError(
      "response",
      "The S3 object is not a valid encrypted vault backup.",
    );
  }
  return bytes;
}
function item(id: string, notes: string): SecretBackendItem {
  return { id, name: id, kind: "note", notes, secret: "" };
}
function backupFiles(owner: Owner) {
  const { parameters } = owner.saved.configuration;
  const credentials = owner.saved.privateState.credentials;
  return makeS3SecretFiles({
    endpoint: parameters.endpoint ?? "",
    region: parameters.region ?? "",
    bucket: parameters.bucket ?? "",
    prefix: parameters.prefix ?? "",
    prefixMode: "literal",
    credentials: {
      accessKeyId: parameters.access_key_id ?? "",
      secretAccessKey: Redacted.make(credentials.secret_access_key ?? ""),
      sessionToken: credentials.session_token
        ? Redacted.make(credentials.session_token)
        : undefined,
    },
    maxBytes: MAX_FILE_BYTES,
    fetch: owner.transport.fetch,
    signal: owner.signal,
    assertCurrent: owner.check,
  });
}
async function runOperation<T>(
  owner: Owner,
  effect: Effect.Effect<T, SecretFsError>,
): Promise<T> {
  await owner.current();
  const result = await Effect.runPromise(
    Effect.match(effect, {
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );
  // Refresh the same durable revision after I/O, before readback or import can follow.
  await owner.current();
  if (result.ok) return result.value;
  const error = result.error;
  if (error._tag === "SecretFsRejected" && error.kind === "permission") {
    try {
      await invalidateNativeS3(owner.saved, owner.transport);
    } finally {
      owner.close();
    }
    throw new SecretBackendError(
      "authentication",
      "S3 refused this saved signing credential. Verify the connection again.",
    );
  }
  const code =
    error._tag === "SecretFsNotFound"
      ? "not-found"
      : error._tag === "SecretFsConflict"
        ? "configuration"
        : error._tag === "SecretFsRejected"
          ? "response"
          : "network";
  throw new SecretBackendError(
    code,
    "The encrypted S3 backup operation did not complete.",
  );
}
function backupOperations(owner: Owner, session: SecretBackendSession) {
  const files = backupFiles(owner);
  function checkSession(presented: SecretBackendSession) {
    owner.check();
    if (presented !== session)
      throw new SecretBackendError(
        "stale",
        "This S3 backup belongs to another session.",
      );
  }
  async function getItem(reference: string, presented: SecretBackendSession) {
    checkSession(presented);
    const read = await runOperation(owner, files.read(reference));
    owner.check();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      throw new SecretBackendError(
        "response",
        "The S3 backup is not valid UTF-8 ciphertext.",
      );
    }
    ciphertext(text);
    owner.check();
    return item(reference, text);
  }
  async function createItem(
    input: SecretBackendItemInput,
    presented: SecretBackendSession,
  ) {
    checkSession(presented);
    if (!input.name.trim() || input.kind !== "note" || input.secret)
      throw new SecretBackendError(
        "configuration",
        "Store a named encrypted backup as an S3 note.",
      );
    const bytes = ciphertext(input.notes);
    const reference = `backups/${crypto.randomUUID()}.json`;
    await runOperation(
      owner,
      files.write(reference, bytes, { ifRevision: null }),
    );
    owner.check();
    return item(reference, input.notes);
  }
  return { getItem, createItem };
}
export async function openNativeS3Backup(
  id: string,
  options: NativeS3BackupOptions,
): Promise<SecretBackendBackupHandle> {
  const owner = await captureNativeS3Backup(id, options);
  try {
    const session: SecretBackendSession = Object.freeze({
      id: crypto.randomUUID(),
      backendId: `native-s3:${id}`,
      authenticatedAt: new Date().toISOString(),
      signal: owner.signal,
    });
    const operations = backupOperations(owner, session);
    const backend: SecretBackend = {
      id: session.backendId,
      name: owner.saved.configuration.displayName,
      signal: owner.signal,
      capabilities: {
        itemKinds: ["note"],
        itemFields: ["notes"],
        vaultBackup: { kind: "note", field: "notes", maxBytes: MAX_FILE_BYTES },
        list: false,
        get: true,
        create: true,
        update: false,
        delete: false,
        import: false,
      },
      authenticate: async () => unsupported(),
      listItems: async () => unsupported(),
      getNotes: async (reference, presented) =>
        (await operations.getItem(reference, presented)).notes,
      ...operations,
      disconnect: async (presented) => {
        if (presented !== session)
          throw new SecretBackendError(
            "stale",
            "This S3 backup belongs to another session.",
          );
        owner.close();
      },
    };
    return { backend, session };
  } catch (error) {
    owner.close();
    throw error;
  }
}
