import { expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { catalogProvider } from "./connector-catalog.js";
import {
  readDeviceRows,
  readDeviceSecrets,
  writeDeviceRows,
  writeDeviceSecrets,
} from "./device-connector-records.js";
import {
  createDeviceConnection,
  forgetDeviceConnectors,
  revokeDeviceConnection,
  runFeatureConnector,
  sealDeviceCredential,
} from "./device-connectors.js";
import { runListedFeature } from "./feature-connector-operation.js";
import {
  performSavedCategory,
  registerCategorySend,
  sendFeatureOperation,
} from "./feature-request-send.js";
import {
  currentUse,
  dispatchFeatureCall,
  dispatchedFeatureCall,
  featureRequest,
  rememberUses,
} from "./feature-request.js";
import {
  forgetAllLocalGitRemotes,
  forgetLocalGitRemote,
  getLocalGitRemote,
  listLocalGitRemotes,
  rememberLocalGitRemote,
} from "./git-remote-local.js";
import { enrollRetiredCredential } from "./retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "./retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";
import { bindSavedGitBackup, savedGitBackupUse } from "./saved-git-backup.js";
import { vaultStore } from "./vault/store.js";
const PASSWORD = "fresh-real-owner-password";
const RETIRED = "selected-old-owner-password";
const SECRET = "real-saved-provider-key";
it("saved connector authority stays sealed through retired synthetic admission and public lock until fresh original owner proof", async () => {
  configureHost(createTestHost({ locks: webLocksDouble() }));
  await vaultStore.create(PASSWORD);
  await vaultStore.flushPendingWrites();
  const provider = catalogProvider("anthropic");
  if (!provider) throw new Error("Missing production provider.");
  const connection = createDeviceConnection({
    providerId: provider.id,
    displayName: "Owner connector",
  });
  sealDeviceCredential(connection.connectionId, SECRET);
  const positive = runListedFeature(provider);
  expect(positive.ok && positive.secrets.credential).toBe(SECRET);
  const remote = await rememberLocalGitRemote({
    displayName: "Private owner remote",
    configuration: {
      remote_url: "https://private.example.test/owner/repo",
      auth_mode: "https_token",
      token: SECRET,
    },
  });
  const captured = runListedFeature(provider);
  const heldRequest = featureRequest(provider);
  rememberUses([heldRequest]);
  dispatchFeatureCall(heldRequest);
  if (heldRequest.ok) bindSavedGitBackup([heldRequest]);
  const unregister = registerCategorySend("held-fixture", () => [heldRequest]);
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  await enrollRetiredCredential({
    tomb: vaultStore.activeTomb(),
    currentPassword: PASSWORD,
    retiredPassword: RETIRED,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  vaultStore.lock();
  try {
    expect(await unlockWithRetiredCredentialGate(vaultStore, RETIRED)).toBe(
      "retired_credential_session",
    );
    expect(vaultStore.getSnapshot().decoy).toBe(true);
    expect({
      backup: savedGitBackupUse(provider.id)?.secret,
      dispatched: dispatchedFeatureCall(provider.id)?.secret,
    }).toEqual({ backup: undefined, dispatched: undefined });
    expect(getLocalGitRemote(remote.id)).toBeNull();
    expect(listLocalGitRemotes()).toEqual([]);
    for (const state of ["synthetic", "pending"] as const) {
      if (state === "pending") vaultStore.lock();
      await expect(forgetLocalGitRemote(remote.id)).rejects.toThrow();
      await expect(forgetAllLocalGitRemotes()).rejects.toThrow();
      await expect(
        rememberLocalGitRemote({
          displayName: "Denied",
          configuration: {
            remote_url: "https://private.example.test/denied",
            auth_mode: "https_token",
            token: SECRET,
          },
        }),
      ).rejects.toThrow();
      expect(() => sendFeatureOperation(captured)).toThrow();
      expect(() => performSavedCategory(["held-fixture"])).toThrow();
      expect(currentUse(provider.id).ok).toBe(false);
      expect(readDeviceSecrets()).toEqual({});
      expect(readDeviceRows()).toEqual([]);
      expect(() => runListedFeature(provider)).toThrow();
      expect(() => runFeatureConnector(provider)).toThrow();
      expect(() => writeDeviceSecrets({})).toThrow();
      expect(() => writeDeviceRows([])).toThrow();
      expect(() => forgetDeviceConnectors()).toThrow();
      expect(() => revokeDeviceConnection(connection.connectionId)).toThrow();
    }
    await flushRetiredCredentialTelemetry();
    await expect(
      unlockWithRetiredCredentialGate(vaultStore, "wrong-owner-password"),
    ).rejects.toThrow();
    expect(readDeviceSecrets()).toEqual({});
    expect(await unlockWithRetiredCredentialGate(vaultStore, PASSWORD)).toBe(
      "vault_opened",
    );
    expect(savedGitBackupUse(provider.id)).toBeNull();
    expect(dispatchedFeatureCall(provider.id)).toBeUndefined();
    expect(currentUse(provider.id).ok).toBe(false);
    expect(() => sendFeatureOperation(captured)).toThrow();
    expect(() => performSavedCategory(["held-fixture"])).toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(getLocalGitRemote(remote.id)?.remoteUrl).toBe(
      "https://private.example.test/owner/repo",
    );
    const restored = runListedFeature(provider);
    expect(restored.ok && restored.secrets.credential).toBe(SECRET);
    expect(readDeviceSecrets()[connection.connectionId]?.credential).toBe(
      SECRET,
    );
    const beforeRemotes = listLocalGitRemotes().map((row) => row.id);
    const actualAddItems = vaultStore.addItems.bind(vaultStore);
    // Hold only the awaited scheduling boundary; the actual encryption, storage,
    // retired classifier and public principal transitions all execute normally.
    const heldWrite = vi
      .spyOn(vaultStore, "addItems")
      .mockImplementationOnce(async (items) => {
        await actualAddItems(items);
        vaultStore.lock();
        await unlockWithRetiredCredentialGate(vaultStore, RETIRED);
      });
    try {
      await expect(
        rememberLocalGitRemote({
          displayName: "Stale publication",
          configuration: {
            remote_url: "https://private.example.test/stale",
            auth_mode: "https_token",
            token: SECRET,
          },
        }),
      ).rejects.toThrow();
      expect(vaultStore.getSnapshot().decoy).toBe(true);
    } finally {
      heldWrite.mockRestore();
    }
    vaultStore.lock();
    await flushRetiredCredentialTelemetry();
    await unlockWithRetiredCredentialGate(vaultStore, PASSWORD);
    expect(listLocalGitRemotes().map((row) => row.id)).toEqual(beforeRemotes);
  } finally {
    unregister();
    transport.mockRestore();
    await flushRetiredCredentialTelemetry();
    if (vaultStore.getSnapshot().decoy) vaultStore.lock();
    if (vaultStore.getSnapshot().status !== "unlocked")
      await unlockWithRetiredCredentialGate(vaultStore, PASSWORD);
    await forgetAllLocalGitRemotes();
    forgetDeviceConnectors();
    vaultStore.lock();
  }
});
