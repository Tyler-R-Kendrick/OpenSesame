import { expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import {
  getHistoryAccount,
  putHistoryAccount,
  resetHistoryBackupMemory,
} from "./history-backup-idb.js";
import { legacyHistoryStore } from "./history-backup-legacy.js";
import { enrollRetiredCredential } from "./retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "./retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";
import { vaultStore } from "./vault/store.js";

it("withholds an original history account credential handle after retired routing and restores fresh owner access", async () => {
  const originalHost = host();
  const password = "history-original-owner-proof";
  const retired = "history-retired-proof";
  let ownerCreated = false;
  let resume = () => {};
  let settled: Promise<void> | undefined;
  configureHost(createTestHost({ locks: webLocksDouble() }));
  try {
    resetHistoryBackupMemory();
    await vaultStore.create(password);
    ownerCreated = true;
    await vaultStore.flushPendingWrites();
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: password,
      retiredPassword: retired,
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
    // This public row contains an opaque provisional provider credential handle,
    // not a plaintext snapshot, vault password or authenticated owner root.
    const account = {
      id: "original-history-account",
      providerId: "postgres",
      anonToken: "generated-opaque-history-handle",
      claimState: "provisional" as const,
      createdAt: "2026-10-07T00:00:00Z",
    };
    await putHistoryAccount(account);
    expect(await getHistoryAccount(account.id)).toEqual(account);
    expect(
      await getHistoryAccount("other-unregistered-account"),
    ).toBeUndefined();
    const original = legacyHistoryStore.getAccount;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const read = vi
      .spyOn(legacyHistoryStore, "getAccount")
      .mockImplementationOnce(async (id) => {
        const result = await original(id);
        await gate;
        return result;
      });
    const pending = getHistoryAccount(account.id).then(
      (value) => ({ accepted: true as const, value }),
      (error) => ({ accepted: false as const, error }),
    );
    settled = pending.then(() => {});
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
    vaultStore.lock();
    resume();
    const verdict = await pending;
    expect(verdict.accepted && verdict.value !== undefined).toBe(false);
    await flushRetiredCredentialTelemetry();
    await vaultStore.unlock(password);
    expect(await getHistoryAccount(account.id)).toEqual(account);
  } finally {
    try {
      resume();
      await settled;
      await flushRetiredCredentialTelemetry();
      vaultStore.lock();
      if (ownerCreated) {
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
    } finally {
      vi.restoreAllMocks();
      resetHistoryBackupMemory();
      configureHost(originalHost);
    }
  }
});
