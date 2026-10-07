import { expect, it } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { readDeviceSecrets } from "./device-connector-records.js";
import {
  createDeviceConnection,
  revokeDeviceConnection,
  sealDeviceCredential,
} from "./device-connectors.js";
import { clearVaultSurface } from "./vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "./vault/store.js";

it("per-connection revocation tombstones only its own credential and guest onboarding cannot revoke hidden member records", async () => {
  const original = host();
  const password = "device-revoke-original-owner-password";
  let created = false;
  configureHost(createTestHost({ locks: webLocksDouble() }));
  try {
    await clearVaultSurface();
    vaultStore.loadActiveProjectScope();
    await vaultStore.create(password);
    created = true;
    const removed = await createDeviceConnection({
      providerId: "anthropic",
      displayName: "Removed member connection",
    });
    const retained = await createDeviceConnection({
      providerId: "anthropic",
      displayName: "Retained member connection",
    });
    await sealDeviceCredential(removed.connectionId, "removed-controlled-key");
    await sealDeviceCredential(
      retained.connectionId,
      "retained-controlled-key",
    );
    expect(await revokeDeviceConnection(removed.connectionId)).toEqual({
      revoked: true,
      providerRevocation: "ok",
    });
    expect(readDeviceSecrets()[removed.connectionId]).toBeUndefined();
    expect(readDeviceSecrets()[retained.connectionId]?.credential).toBe(
      "retained-controlled-key",
    );
    vaultStore.lock();
    await vaultStore.createGuest({ resume: false });
    expect(await revokeDeviceConnection(retained.connectionId)).toBeNull();
    const guest = await createDeviceConnection({ providerId: "anthropic" });
    await sealDeviceCredential(
      guest.connectionId,
      "guest-onboarding-controlled-key",
    );
    expect(await revokeDeviceConnection(guest.connectionId)).toMatchObject({
      revoked: true,
    });
    expect(readDeviceSecrets()[guest.connectionId]).toBeUndefined();
    vaultStore.lock();
    vaultStore.loadActiveProjectScope();
    await vaultStore.unlock(password);
    expect(readDeviceSecrets()[retained.connectionId]?.credential).toBe(
      "retained-controlled-key",
    );
    expect(readDeviceSecrets()[removed.connectionId]).toBeUndefined();
  } finally {
    try {
      if (created) {
        vaultStore.lock();
        vaultStore.loadActiveProjectScope();
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
    } finally {
      configureHost(original);
    }
  }
});
