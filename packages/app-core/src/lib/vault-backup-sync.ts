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
import { backupOriginAllowed } from "./backup-egress-gate.js";
import { utf8ToBase64 } from "./backup-encoding.js";
import { sealedEnvelopeJson } from "./backup-sealed-envelope.js";
import { readSecretToken } from "./backup-secret-token.js";
import {
  type LocalBackupTarget,
  clearLocalBackupPending,
  listLocalBackupTargets,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { readBoundedObject } from "./bounded-response.js";
import { decoyGuardedFetch } from "./decoy-fetch.js";
import { assertNotDecoySession } from "./decoy-session.js";
import {
  performSavedCategory,
  performSavedConnector,
} from "./feature-request-send.js";
import {
  type GitBackupForge,
  forgeForProvider,
  forgeFromRemoteUrl,
} from "./git-backup-forges.js";
import { getLocalGitRemote } from "./git-remote-local.js";
import { pemFromVault, readLocalGithubApp } from "./github-app-local.js";
import { githubAppRelayBase } from "./github-app-relay.js";
import { savedForgeCredentials } from "./saved-git-backup.js";
import { vaultStore } from "./vault/store.js";

type PutContentsResult = { commitSha: string | null };

/** Git backup withdrawn, or the relay off the operator's allowlist: no call. */
function refuseUnlessAllowed(base: string): void {
  if (!backupOriginAllowed(base)) {
    throw new Error("The operator's policy does not allow this backup.");
  }
}

async function putGithubContentsDefault(input: {
  appId: string;
  pem: string;
  installationId: string;
  owner: string;
  repo: string;
  branch: string;
  contentBase64: string;
}): Promise<PutContentsResult> {
  const authorityGeneration = assertNotDecoySession();
  const base = githubAppRelayBase();
  if (base === "") throw new Error("Connect relay is not configured.");
  refuseUnlessAllowed(base);
  const response = await decoyGuardedFetch(
    `${base}/api/github-app/put-contents`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  const payload: JsonObject = overlapCast(
    await readBoundedObject(response, 65536, 30_000).catch(() => ({})),
  );
  assertNotDecoySession(authorityGeneration);
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
  fields?: Record<string, string>;
}): Promise<PutContentsResult> {
  const authorityGeneration = assertNotDecoySession();
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
  if (input.fields) body.fields = { ...input.fields };
  if (input.username) body.username = input.username;
  refuseUnlessAllowed(base);
  const response = await decoyGuardedFetch(`${base}/api/git-backup/put`, {
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
  assertNotDecoySession(authorityGeneration);
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
  if (base === "" || !backupOriginAllowed(base)) return 0;
  const creds = vaultBackupSyncSeams.resolveCredentials();
  if (!creds) return 0;
  const targets = listLocalBackupTargets().filter(
    (row) => row.enabled && row.kind === "github_app" && row.installationId,
  );
  if (targets.length === 0) return 0;
  let total = 0;
  for (const target of targets) {
    try {
      const response = await decoyGuardedFetch(
        `${base}/api/github-app/webhook-pending`,
        {
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
        },
      );
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
  const pem = app ? pemFromVault(app) : null;
  if (!app?.id || !pem) return null;
  return { appId: app.id, pem };
}

type ForgeCredentials = {
  forge: GitBackupForge;
  token: string;
  username: string | null;
  fields?: Record<string, string>;
};

export {
  type SavedGitBackup,
  bindSavedGitBackup,
  resetSavedGitBackupForTest,
  savedGitBackupUse,
} from "./saved-git-backup.js";

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

function httpsRemote(connectionId: string | null) {
  if (!connectionId) return null;
  const remote = getLocalGitRemote(connectionId);
  if (!remote?.secretItemId) return null;
  if (remote.authMode !== "https_token" && remote.authMode !== "https_basic") {
    return null;
  }
  return remote;
}

function resolveForgeCredentialsDefault(
  target: LocalBackupTarget,
): ForgeCredentials | null {
  const fromSaved = savedForgeCredentials(target.providerId ?? "");
  if (fromSaved) return fromSaved;
  const remote = httpsRemote(target.connectionId);
  if (!remote) return null;
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

/** Push one forge remote with the token saved on Capabilities. */
export async function pushSavedForgeBackup(
  target: LocalBackupTarget,
): Promise<string | null> {
  const authorityGeneration = assertNotDecoySession();
  const creds = vaultBackupSyncSeams.resolveForgeCredentials(target);
  if (!creds) {
    throw new Error("Unlock the vault and use an HTTPS token for this remote.");
  }
  const json = vaultBackupSyncSeams.sealedEnvelopeJson();
  const put = {
    forge: creds.forge,
    token: creds.token,
    username: creds.username,
    owner: target.owner,
    repo: target.repo,
    branch: target.branch,
    contentBase64: utf8ToBase64(json),
  };
  const result = await vaultBackupSyncSeams.putForgeContents(
    creds.fields ? { ...put, fields: creds.fields } : put,
  );
  assertNotDecoySession(authorityGeneration);
  return result.commitSha;
}

async function syncOneTarget(
  target: LocalBackupTarget,
): Promise<LocalBackupTarget | null> {
  const authorityGeneration = assertNotDecoySession();
  if (!target.enabled) return target;
  if (target.providerId) performSavedConnector(target.providerId);
  const providerKey = target.providerId ?? "github";
  try {
    let commitSha: string | null = null;
    if (target.kind === "git_remote") {
      commitSha = await pushSavedForgeBackup(target);
    } else {
      const json = vaultBackupSyncSeams.sealedEnvelopeJson();
      const contentBase64 = utf8ToBase64(json);
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
    assertNotDecoySession(authorityGeneration);
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
    assertNotDecoySession(authorityGeneration);
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
  const authorityGeneration = assertNotDecoySession();
  performSavedCategory(["cloud_secret_storage", "encryption"]);
  performSavedCategory(["backup_recovery"]);
  if (providerId) {
    const target = readLocalBackupTarget(providerId);
    if (!target || !target.enabled) return target;
    return syncOneTarget(target);
  }
  const enabled = listLocalBackupTargets().filter((row) => row.enabled);
  let last: LocalBackupTarget | null = null;
  let failure: { error: unknown } | null = null;
  for (const target of enabled) {
    try {
      assertNotDecoySession(authorityGeneration);
      last = await syncOneTarget(target);
    } catch (caught) {
      assertNotDecoySession(authorityGeneration);
      failure ??= { error: caught };
    }
  }
  if (failure !== null) throw failure.error;
  return last;
}

export async function drainBackupWebhooks(): Promise<number> {
  const authorityGeneration = assertNotDecoySession();
  const result = await vaultBackupSyncSeams.drainWebhookPending();
  assertNotDecoySession(authorityGeneration);
  return result;
}
