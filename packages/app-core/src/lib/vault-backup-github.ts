/** Default GitHub App backup operations: direct REST, original owner and no relay. */
import { z } from "zod";
import { backupOriginAllowed } from "./backup-egress-gate.js";
import {
  listLocalBackupTargets,
  subscribeLocalBackupTarget,
} from "./backup-target-local.js";
import {
  putGithubAppBackup,
  readGithubAppBackup,
} from "./github-app-backup-direct.js";
import {
  createGithubInstallationToken,
  githubApiJson,
} from "./github-app-direct.js";
import { base64ToBytes, bytesToBase64 } from "./native-base64.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import type {
  SecretBackendBackupHandle,
  VaultBackupPort,
} from "./secret-backends/backup-transfer.js";
import { localVaultSessionGuard } from "./secret-backends/local-vault-port.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendSession,
} from "./secret-backends/types.js";
import { sealedVaultText } from "./vault/offline-backup-file.js";
import { vaultStore } from "./vault/store.js";

import {
  type GithubRestoreOwner,
  type SavedGithubBackupRequest,
  captureSavedGithubBackup as capture,
  savedGithubBackupRequest as request,
  reserveGithubBackupWrite,
} from "./vault-backup-github-owner.js";
export type { SavedGithubBackupRequest } from "./vault-backup-github-owner.js";

/** Keep the original authority alive until the caller publishes confirmed sync metadata. */
export async function putSavedGithubBackup(
  input: SavedGithubBackupRequest & { contentBase64: string },
  native?: NativeProviderTransport,
) {
  const operation = capture(input, native);
  let release = () => {};
  try {
    const encoded = input.contentBase64;
    if (encoded.length > 750000)
      throw new Error("The encrypted backup is too large.");
    const bytes = base64ToBytes(encoded);
    if (bytesToBase64(bytes) !== encoded)
      throw new Error("Invalid encrypted backup encoding.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const slot = reserveGithubBackupWrite(operation);
    release = slot.release;
    await slot.wait;
    const result = await putGithubAppBackup(
      operation.transport,
      operation.credentials,
      operation.target,
      text,
    );
    operation.transport.assertCurrent();
    return {
      ...result,
      assertCurrent: operation.transport.assertCurrent,
      pendingAfter: slot.pendingAfter,
      publish: slot.publish,
      close: () => {
        operation.close();
        release();
      },
    };
  } catch (error) {
    operation.close();
    release();
    throw error;
  }
}

/** Read real provider ciphertext while retaining the original captured session. */
export async function readSavedGithubBackup(
  providerId = "github",
  native?: NativeProviderTransport,
) {
  const operation = capture(request(providerId), native);
  try {
    const text = await readGithubAppBackup(
      operation.transport,
      operation.credentials,
      operation.target,
    );
    operation.transport.assertCurrent();
    return {
      text,
      assertCurrent: operation.transport.assertCurrent,
      close: operation.close,
    };
  } catch (error) {
    operation.close();
    throw error;
  }
}

/** Merge through the existing real importer; destination identity and enrolled unlocks stay its own. */
export async function restoreSavedGithubBackup(
  providerId: string,
  secret: string | Uint8Array,
  destination: VaultBackupPort = vaultStore,
  native?: NativeProviderTransport,
): Promise<number> {
  const guard = localVaultSessionGuard(destination);
  const unlock = secret instanceof Uint8Array ? secret.slice() : secret;
  let open: Awaited<ReturnType<typeof readSavedGithubBackup>> | null = null;
  try {
    open = await readSavedGithubBackup(providerId, native);
    const check = () => {
      guard.current();
      open?.assertCurrent();
    };
    check();
    const count = await destination.importSealed(
      sealedVaultText(open.text),
      unlock,
      { adoptIdentity: false, assertCurrent: check },
    );
    check();
    await destination.flushPendingWrites();
    check();
    return count;
  } finally {
    if (unlock instanceof Uint8Array) unlock.fill(0);
    open?.close();
    guard.close();
  }
}

/** Actual branch-head polling replaces relay webhook draining. */
export async function pollSavedGithubBackups(): Promise<number> {
  if (!backupOriginAllowed("https://api.github.com")) return 0;
  let changed = 0;
  for (const target of listLocalBackupTargets().filter(
    (row) => row.enabled && row.kind === "github_app",
  )) {
    const operation = capture(request(target.providerId ?? "github"));
    try {
      const token = await createGithubInstallationToken(
        operation.transport,
        operation.credentials,
        operation.target.installationId,
        target.repo,
        "read",
      );
      const value = await githubApiJson(
        operation.transport,
        `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/ref/heads/${target.branch.split("/").map(encodeURIComponent).join("/")}`,
        { method: "GET", token },
      );
      const head = z
        .object({
          ref: z.string(),
          object: z.object({
            type: z.literal("commit"),
            sha: z
              .string()
              .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
              .refine((value) => !/^0+$/.test(value)),
          }),
        })
        .parse(value);
      operation.transport.assertCurrent();
      if (head.ref !== `refs/heads/${target.branch}`)
        throw new Error("Unexpected backup branch.");
      if (head.object.sha !== target.lastCommitSha) changed += 1;
    } finally {
      operation.close();
    }
  }
  return changed;
}

function stale(): never {
  throw new Error("The GitHub backup owner or target changed.");
}
const BACKUP_REFERENCE = "opensesame-vault.backup.json";
function readonlyGithubBackup(
  operation: ReturnType<typeof capture>,
  owner: GithubRestoreOwner,
) {
  let closed = false;
  let authenticated = false;
  let unsubscribe = () => {};
  const check = () => {
    if (closed) stale();
    owner.assertCurrent();
    operation.transport.assertCurrent();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    operation.transport.signal.removeEventListener("abort", close);
    operation.close();
  };
  const session: SecretBackendSession = Object.freeze({
    id: crypto.randomUUID(),
    backendId: "github-app-backup",
    authenticatedAt: new Date().toISOString(),
    signal: operation.transport.signal,
  });
  const read = async () => {
    check();
    const text = await readGithubAppBackup(
      operation.transport,
      operation.credentials,
      operation.target,
    );
    check();
    return text;
  };
  const getItem: SecretBackend["getItem"] = async (reference, provided) => {
    check();
    if (!authenticated || provided !== session) stale();
    if (reference !== BACKUP_REFERENCE)
      throw new SecretBackendError(
        "configuration",
        "Choose this connection's encrypted vault backup.",
      );
    return {
      id: BACKUP_REFERENCE,
      name: BACKUP_REFERENCE,
      kind: "note",
      notes: await read(),
      secret: "",
    };
  };
  const authenticate = async () => {
    await read();
    check();
    authenticated = true;
    return session;
  };
  const backend: SecretBackend = {
    id: session.backendId,
    name: "GitHub encrypted vault backup",
    signal: operation.transport.signal,
    capabilities: {
      list: false,
      get: true,
      create: false,
      update: false,
      delete: false,
      import: false,
    },
    authenticate,
    getItem,
    getNotes: async (reference, provided) =>
      (await getItem(reference, provided)).notes,
    listItems: async (provided) => {
      check();
      if (!authenticated || provided !== session) stale();
      return [];
    },
    disconnect: async (provided) => {
      if (provided !== session) stale();
      close();
    },
  };
  operation.transport.signal.addEventListener("abort", close, { once: true });
  unsubscribe = subscribeLocalBackupTarget(() => {
    try {
      check();
    } catch {
      close();
    }
  });
  return { backend, authenticate, check, close };
}

/** Capture before any await; authentication reads and validates the actual provider backup. */
export async function openSavedGithubBackup(
  providerId: string,
  caller: GithubRestoreOwner,
  native?: NativeProviderTransport,
): Promise<SecretBackendBackupHandle> {
  const owner = { signal: caller.signal, assertCurrent: caller.assertCurrent };
  owner.signal.throwIfAborted();
  owner.assertCurrent();
  const operation = capture(request(providerId), native, owner);
  const open = readonlyGithubBackup(operation, owner);
  try {
    const session = await open.authenticate();
    open.check();
    return { backend: open.backend, session };
  } catch (error) {
    open.close();
    throw error;
  }
}
