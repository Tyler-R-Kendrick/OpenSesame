import { expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";

import { sealedEnvelopeJson } from "./backup-sealed-envelope.js";
import type { LocalBackupTarget } from "./backup-target-local.js";
import { rememberLocalGitRemote } from "./git-remote-local.js";
import { enrollRetiredCredential } from "./retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "./retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";
import {
  pushSavedForgeBackup,
  vaultBackupSyncSeams,
} from "./vault-backup-sync.js";
import { vaultStore } from "./vault/store.js";

it("withholds a held backup completion after original owner withdrawal and permits fresh owner", async () => {
  const originalHost = host();
  let ownerCreated = false;
  configureHost(createTestHost({ locks: webLocksDouble() }));
  const password = "backup-original-owner-proof";
  const retired = "backup-retired-proof";
  let finish = (_value: { commitSha: string }) => {};
  let settled: Promise<void> | undefined;
  try {
    await vaultStore.create(password);
    ownerCreated = true;
    const remote = await rememberLocalGitRemote({
      displayName: "Owner backup",
      configuration: {
        remote_url: "https://gitlab.example.test/owner/private",
        auth_mode: "https_token",
        token: "owner-backup-generated-token",
      },
    });
    await vaultStore.flushPendingWrites();
    const envelope = sealedEnvelopeJson();
    expect(envelope).not.toContain("owner-backup-generated-token");
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: password,
      retiredPassword: retired,
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
    const target: LocalBackupTarget = {
      kind: "git_remote",
      providerId: "gitlab",
      connectionId: remote.id,
      integrationId: "",
      installationId: "",
      owner: "owner",
      repo: "private",
      branch: "main",
      enabled: true,
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: null,
      pendingEvents: 0,
    };
    const transport = vi
      .spyOn(vaultBackupSyncSeams, "putForgeContents")
      .mockResolvedValue({ commitSha: "fresh-commit" });
    expect(await pushSavedForgeBackup(target)).toBe("fresh-commit");
    transport.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = pushSavedForgeBackup(target).then(
      (value) => ({ accepted: true, value }),
      (error) => ({ accepted: false, error }),
    );
    settled = pending.then(() => {});
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
    expect(() => sealedEnvelopeJson()).toThrow();
    vaultStore.lock();
    finish({ commitSha: "stale-original-commit" });
    expect((await pending).accepted).toBe(false);
    await expect(pushSavedForgeBackup(target)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
    await flushRetiredCredentialTelemetry();
    await vaultStore.unlock(password);
    expect(await pushSavedForgeBackup(target)).toBe("fresh-commit");
    transport.mockRejectedValueOnce(
      new Error("remote refuses conflicting revision"),
    );
    await expect(pushSavedForgeBackup(target)).rejects.toThrow(
      "remote refuses conflicting revision",
    );
    expect(await pushSavedForgeBackup(target)).toBe("fresh-commit");
    expect(sealedEnvelopeJson()).not.toContain("owner-backup-generated-token");
  } finally {
    try {
      finish({ commitSha: "fixture-close" });
      await settled;
      await flushRetiredCredentialTelemetry();
      vaultStore.lock();
      if (ownerCreated) {
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
    } finally {
      vi.restoreAllMocks();
      configureHost(originalHost);
    }
  }
});
