/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { syncVaultBackup, vaultBackupSyncSeams } from "./vault-backup-sync.js";

const original = { ...vaultBackupSyncSeams };

beforeEach(() => {
  clearLocalBackupTarget();
  Object.assign(vaultBackupSyncSeams, original);
});

afterEach(() => {
  Object.assign(vaultBackupSyncSeams, original);
});

describe("syncVaultBackup", () => {
  it("no-ops when backup is disabled", async () => {
    writeLocalBackupTarget({
      kind: "github_app",
      providerId: "github",
      connectionId: null,
      integrationId: "",
      installationId: "9",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled: false,
      status: "ok",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: null,
      pendingEvents: 0,
    });
    const putContents = vi.fn(async () => ({ commitSha: "x" }));
    Object.assign(vaultBackupSyncSeams, {
      putContents,
      sealedEnvelopeJson: () => "{}",
      resolveCredentials: () => ({ appId: "1", pem: "PEM" }),
    });
    const result = await syncVaultBackup("github");
    expect(result?.enabled).toBe(false);
    expect(putContents).not.toHaveBeenCalled();
  });

  it("pushes sealed ciphertext for a GitHub App target", async () => {
    writeLocalBackupTarget({
      kind: "github_app",
      providerId: "github",
      connectionId: null,
      integrationId: "",
      installationId: "9",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled: true,
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: null,
      pendingEvents: 0,
    });
    const putContents = vi.fn(async () => ({ commitSha: "deadbeef" }));
    Object.assign(vaultBackupSyncSeams, {
      putContents,
      sealedEnvelopeJson: () => '{"format":"opensesame-offline-backup","v":1}',
      resolveCredentials: () => ({ appId: "1", pem: "PEM" }),
    });
    const result = await syncVaultBackup("github");
    expect(putContents).toHaveBeenCalled();
    expect(result?.lastCommitSha).toBe("deadbeef");
    expect(readLocalBackupTarget("github")?.status).toBe("ok");
  });

  it("pushes sealed ciphertext for a GitLab git_remote target", async () => {
    writeLocalBackupTarget({
      kind: "git_remote",
      providerId: "gitlab",
      connectionId: "git_local_abc",
      integrationId: "",
      installationId: "",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled: true,
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: { remoteUrl: "https://gitlab.com/acme/vault.git" },
      pendingEvents: 0,
    });
    const putForgeContents = vi.fn(async () => ({ commitSha: "gl-1" }));
    Object.assign(vaultBackupSyncSeams, {
      putForgeContents,
      sealedEnvelopeJson: () => '{"v":1}',
      resolveForgeCredentials: () => ({
        forge: "gitlab" as const,
        token: "glpat-x",
        username: null,
      }),
    });
    const result = await syncVaultBackup("gitlab");
    expect(putForgeContents).toHaveBeenCalled();
    expect(result?.lastCommitSha).toBe("gl-1");
    expect(readLocalBackupTarget("gitlab")?.providerId).toBe("gitlab");
  });
});
