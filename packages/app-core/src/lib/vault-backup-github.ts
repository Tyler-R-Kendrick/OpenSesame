/** Default GitHub App backup operations: direct REST, original owner and no relay. */
import { canonicalize } from "@opensesame/os-domain";
import { z } from "zod";
import { backupOriginAllowed } from "./backup-egress-gate.js";
import {
  listLocalBackupTargets,
  readLocalBackupTarget,
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
import type { GithubDirectTransport } from "./github-app-direct.js";
import { pemFromVault, readLocalGithubApp } from "./github-app-local.js";
import { captureGithubAuthority } from "./github-app-vault-transport.js";
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

export type SavedGithubBackupRequest = {
  appId: string;
  pem: string;
  installationId: string;
  owner: string;
  repo: string;
  branch: string;
  providerId?: string;
};
function stale(): never {
  throw new Error("The GitHub backup owner or target changed.");
}
function boundTarget(saved: SavedGithubBackupRequest) {
  const providerId = saved.providerId ?? "github";
  const target = readLocalBackupTarget(providerId);
  if (
    !target?.enabled ||
    target.kind !== "github_app" ||
    target.installationId !== saved.installationId ||
    target.owner !== saved.owner ||
    target.repo !== saved.repo ||
    target.branch !== saved.branch ||
    !/^[1-9]\d*$/.test(saved.installationId) ||
    !Number.isSafeInteger(Number(saved.installationId))
  )
    stale();
  return { providerId, receipt: canonicalize(target) };
}
function capture(
  input: SavedGithubBackupRequest,
  native?: NativeProviderTransport,
  caller?: GithubRestoreOwner,
) {
  const saved = { ...input };
  const { providerId, receipt } = boundTarget(saved);
  const operation = captureGithubAuthority({
    binding: () => {
      const app = readLocalGithubApp();
      return (
        canonicalize(readLocalBackupTarget(providerId)) === receipt &&
        app?.id === saved.appId &&
        pemFromVault(app) === saved.pem
      );
    },
  });
  try {
    const fetch = native?.fetch ?? globalThis.fetch;
    const assertNative = native?.assertCurrent;
    const nativeSignal = native?.signal;
    const signal = AbortSignal.any([
      operation.transport.signal,
      ...(caller ? [caller.signal] : []),
      ...(nativeSignal ? [nativeSignal] : []),
    ]);
    const check = () => {
      signal.throwIfAborted();
      caller?.assertCurrent();
      operation.transport.assertCurrent();
      if (native) {
        if (
          !nativeSignal ||
          native.fetch !== fetch ||
          native.assertCurrent !== assertNative ||
          native.signal !== nativeSignal
        )
          stale();
        assertNative?.call(native);
        operation.transport.assertCurrent();
      }
      caller?.assertCurrent();
    };
    const transport: GithubDirectTransport = {
      signal,
      assertCurrent: check,
      fetch: (input, init) => {
        check();
        return fetch.call(native ?? globalThis, input, init);
      },
    };
    check();
    return {
      transport,
      target: {
        owner: saved.owner,
        repo: saved.repo,
        branch: saved.branch,
        installationId: Number(saved.installationId),
      },
      credentials: { appId: saved.appId, privateKey: saved.pem },
      close: operation.close,
    };
  } catch (error) {
    operation.close();
    throw error;
  }
}
function request(providerId: string): SavedGithubBackupRequest {
  const target = readLocalBackupTarget(providerId);
  const app = readLocalGithubApp();
  const pem = app ? pemFromVault(app) : null;
  if (!target || !app?.id || !pem) stale();
  return {
    providerId,
    appId: app.id,
    pem,
    installationId: target.installationId,
    owner: target.owner,
    repo: target.repo,
    branch: target.branch,
  };
}

/** Keep the original authority alive until the caller publishes confirmed sync metadata. */
export async function putSavedGithubBackup(
  input: SavedGithubBackupRequest & { contentBase64: string },
  native?: NativeProviderTransport,
) {
  const operation = capture(input, native);
  try {
    const encoded = input.contentBase64;
    if (encoded.length > 750000)
      throw new Error("The encrypted backup is too large.");
    const bytes = base64ToBytes(encoded);
    if (bytesToBase64(bytes) !== encoded)
      throw new Error("Invalid encrypted backup encoding.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
      close: operation.close,
    };
  } catch (error) {
    operation.close();
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

const BACKUP_REFERENCE = "opensesame-vault.backup.json";
type GithubRestoreOwner = { signal: AbortSignal; assertCurrent: () => void };
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
