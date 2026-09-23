/**
 * Push an encrypted vault snapshot to bound backup remotes via the Connect
 * relay. Supports GitHub App installs and forge HTTPS remotes
 * (GitLab / Bitbucket / Codeberg / Cursor Origin).
 */
import {
  type JsonObject,
  isString,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import type { SealedBlob, VaultHeader } from "@opensesame/vault-core";
import {
  type LocalBackupTarget,
  clearLocalBackupPending,
  listLocalBackupTargets,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { readBoundedObject } from "./bounded-response.js";
import {
  type GitBackupForge,
  forgeForProvider,
  forgeFromRemoteUrl,
} from "./git-backup-forges.js";
import { getLocalGitRemote } from "./git-remote-local.js";
import { pemFromVault, readLocalGithubApp } from "./github-app-local.js";
import { githubAppRelayBase } from "./github-app-relay.js";
import {
  buildOfflineBackup,
  serializeOfflineBackup,
} from "./vault/offline-backup.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  readPlaintextFile,
  readSealedFile,
} from "./vfs.js";

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sealedEnvelopeJson(): string {
  const { status, tomb } = vaultStore.getSnapshot();
  if (tomb === GUEST_TOMB) {
    throw new Error("Guest vaults cannot sync to a backup remote.");
  }
  if (status !== "unlocked" && status !== "locked") {
    throw new Error("There is no vault to back up.");
  }
  const headerRaw = readPlaintextFile(tomb, HEADER_PATH);
  const body = readSealedFile(tomb, BODY_PATH);
  if (!headerRaw || !body) {
    throw new Error("There is nothing stored to back up yet.");
  }
  const header: VaultHeader = overlapCast(JSON.parse(headerRaw));
  const sealedBody: SealedBlob = body;
  const envelope = buildOfflineBackup({
    projectId: tomb === "personal" ? null : tomb,
    header,
    body: sealedBody,
  });
  return serializeOfflineBackup(envelope);
}

type PutContentsResult = { commitSha: string | null };

async function putGithubContentsDefault(input: {
  appId: string;
  pem: string;
  installationId: string;
  owner: string;
  repo: string;
  branch: string;
  contentBase64: string;
}): Promise<PutContentsResult> {
  const base = githubAppRelayBase();
  if (base === "") throw new Error("Connect relay is not configured.");
  const response = await fetch(`${base}/api/github-app/put-contents`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload: JsonObject = overlapCast(
    await readBoundedObject(response, 65536, 30_000).catch(() => ({})),
  );
  if (!response.ok) {
    throw new Error(
      readString(payload.message) ||
        readString(payload.error) ||
        `Backup write failed (${response.status})`,
    );
  }
  return {
    commitSha: isString(payload.commitSha) ? payload.commitSha : null,
  } satisfies PutContentsResult;
}

async function putForgeContentsDefault(input: {
  forge: GitBackupForge;
  token: string;
  username: string | null;
  owner: string;
  repo: string;
  branch: string;
  contentBase64: string;
}): Promise<PutContentsResult> {
  const base = githubAppRelayBase();
  if (base === "") throw new Error("Connect relay is not configured.");
  const body: JsonObject = {
    forge: input.forge,
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    contentBase64: input.contentBase64,
  };
  if (input.username) body.username = input.username;
  const response = await fetch(`${base}/api/git-backup/put`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload: JsonObject = overlapCast(
    await readBoundedObject(response, 65536, 30_000).catch(() => ({})),
  );
  if (!response.ok) {
    throw new Error(
      readString(payload.message) ||
        readString(payload.error) ||
        `Backup write failed (${response.status})`,
    );
  }
  return {
    commitSha: isString(payload.commitSha) ? payload.commitSha : null,
  } satisfies PutContentsResult;
}

async function drainWebhookPendingDefault(): Promise<number> {
  const base = githubAppRelayBase();
  if (base === "") return 0;
  const creds = vaultBackupSyncSeams.resolveCredentials();
  if (!creds) return 0;
  const targets = listLocalBackupTargets().filter(
    (row) => row.enabled && row.kind === "github_app" && row.installationId,
  );
  if (targets.length === 0) return 0;
  let total = 0;
  for (const target of targets) {
    try {
      const response = await fetch(`${base}/api/github-app/webhook-pending`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appId: creds.appId,
          pem: creds.pem,
          installationId: target.installationId,
        }),
      });
      if (!response.ok) continue;
      const payload: JsonObject = overlapCast(
        await readBoundedObject(response, 65536, 8_000).catch(() => ({})),
      );
      const events = Array.isArray(payload.events) ? payload.events : [];
      total += events.length;
    } catch {
      /* relay unreachable */
    }
  }
  return total;
}

function resolveGithubCredentialsDefault(): {
  appId: string;
  pem: string;
} | null {
  const app = readLocalGithubApp();
  const pem = app ? pemFromVault(app.displayName) : null;
  if (!app?.id || !pem) return null;
  return { appId: app.id, pem };
}

type ForgeCredentials = {
  forge: GitBackupForge;
  token: string;
  username: string | null;
};

function readSecretToken(value: string): string {
  try {
    const secrets: JsonObject = overlapCast(JSON.parse(value));
    const token = readString(secrets.token)?.trim();
    if (token) return token;
    return readString(secrets.password)?.trim() || "";
  } catch {
    return "";
  }
}

function resolveForgeId(
  target: LocalBackupTarget,
  remoteUrl: string,
): ReturnType<typeof forgeForProvider> {
  const providerId = target.providerId ?? "git";
  const fromProvider = forgeForProvider(providerId);
  if (fromProvider) return fromProvider;
  const fromRemote = forgeFromRemoteUrl(remoteUrl);
  if (fromRemote) return fromRemote;
  if (target.config && isString(target.config.remoteUrl)) {
    return forgeFromRemoteUrl(String(target.config.remoteUrl));
  }
  return null;
}

function resolveForgeCredentialsDefault(
  target: LocalBackupTarget,
): ForgeCredentials | null {
  const connectionId = target.connectionId;
  if (!connectionId) return null;
  const remote = getLocalGitRemote(connectionId);
  if (!remote || !remote.secretItemId) return null;
  if (remote.authMode !== "https_token" && remote.authMode !== "https_basic") {
    return null;
  }
  const { status, items } = vaultStore.getSnapshot();
  if (status !== "unlocked") return null;
  const item = items.find((row) => row.id === remote.secretItemId);
  if (!item || item.kind !== "secret") return null;
  const token = readSecretToken(item.value);
  if (!token) return null;
  const forge = resolveForgeId(target, remote.remoteUrl);
  if (!forge) return null;
  return { forge, token, username: remote.username };
}

export const vaultBackupSyncSeams = {
  putContents: putGithubContentsDefault,
  putForgeContents: putForgeContentsDefault,
  drainWebhookPending: drainWebhookPendingDefault,
  sealedEnvelopeJson,
  resolveCredentials: resolveGithubCredentialsDefault,
  resolveForgeCredentials: resolveForgeCredentialsDefault,
};

async function syncOneTarget(
  target: LocalBackupTarget,
): Promise<LocalBackupTarget | null> {
  if (!target.enabled) return target;
  const providerKey = target.providerId ?? "github";
  try {
    const json = vaultBackupSyncSeams.sealedEnvelopeJson();
    const contentBase64 = utf8ToBase64(json);
    let commitSha: string | null = null;
    if (target.kind === "git_remote") {
      const creds = vaultBackupSyncSeams.resolveForgeCredentials(target);
      if (!creds) {
        throw new Error(
          "Unlock the vault and use an HTTPS token for this remote.",
        );
      }
      const result = await vaultBackupSyncSeams.putForgeContents({
        forge: creds.forge,
        token: creds.token,
        username: creds.username,
        owner: target.owner,
        repo: target.repo,
        branch: target.branch,
        contentBase64,
      });
      commitSha = result.commitSha;
    } else {
      const creds = vaultBackupSyncSeams.resolveCredentials();
      if (!creds) {
        throw new Error(
          "GitHub App signing key is not available on this device.",
        );
      }
      const result = await vaultBackupSyncSeams.putContents({
        appId: creds.appId,
        pem: creds.pem,
        installationId: target.installationId,
        owner: target.owner,
        repo: target.repo,
        branch: target.branch,
        contentBase64,
      });
      commitSha = result.commitSha;
    }
    const next: LocalBackupTarget = {
      ...target,
      status: "ok",
      lastCommitSha: commitSha,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
      pendingEvents: 0,
    };
    writeLocalBackupTarget(next);
    clearLocalBackupPending(providerKey);
    return next;
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "Backup sync failed";
    writeLocalBackupTarget({
      ...target,
      status: "error",
      lastError: message,
    });
    throw caught instanceof Error ? caught : new Error(message);
  }
}

/** Push ciphertext for one provider, or every enabled target when omitted. */
export async function syncVaultBackup(
  providerId?: string | null,
): Promise<LocalBackupTarget | null> {
  if (providerId) {
    const target = readLocalBackupTarget(providerId);
    if (!target || !target.enabled) return target;
    return syncOneTarget(target);
  }
  const enabled = listLocalBackupTargets().filter((row) => row.enabled);
  let last: LocalBackupTarget | null = null;
  for (const target of enabled) {
    last = await syncOneTarget(target);
  }
  return last;
}

export async function drainBackupWebhooks(): Promise<number> {
  return vaultBackupSyncSeams.drainWebhookPending();
}
