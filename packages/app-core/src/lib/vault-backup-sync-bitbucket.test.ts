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
  vi.restoreAllMocks();
});

describe("Bitbucket backup confirmation", () => {
  it("accepts a forge write without a commit object", async () => {
    writeLocalBackupTarget({
      kind: "git_remote",
      providerId: "bitbucket",
      connectionId: "git_local_bitbucket",
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
      config: { remoteUrl: "https://bitbucket.org/acme/vault.git" },
      pendingEvents: 0,
    });
    const putForgeContents = vi.fn(async () => ({ commitSha: null }));
    Object.assign(vaultBackupSyncSeams, {
      putForgeContents,
      sealedEnvelopeJson: () => '{"v":1}',
      resolveForgeCredentials: () => ({
        forge: "bitbucket" as const,
        token: "bb-token",
        username: "acme",
      }),
    });
    const result = await syncVaultBackup("bitbucket");
    expect(putForgeContents).toHaveBeenCalled();
    expect(result?.status).toBe("ok");
    expect(result?.lastCommitSha).toBeNull();
    expect(readLocalBackupTarget("bitbucket")?.status).toBe("ok");
  });
});
