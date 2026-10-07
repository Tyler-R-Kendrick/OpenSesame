import { overlapCast } from "@opensesame/os-domain";
import { randomBytes } from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import { configureHost, host } from "../../../host.js";
import { createTestHost } from "../../../test-host.js";
import { webLocksDouble } from "../../__tests__/web-locks-double.js";
import { enrollRetiredCredential } from "../../retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "../../retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "../../retired-credentials/unlock.js";
import { vaultStore } from "../store.js";
import { type PasskeyCeremony, unlockMethodsSeams } from "../unlock-methods.js";

it("rejects an old held PRF ceremony and requires a new original-owner probe after retired routing", async () => {
  const originalHost = host();
  const originalCeremonies = { ...unlockMethodsSeams };
  const password = "prf-original-password";
  const retired = "prf-retired-password";
  let ownerCreated = false;
  let release = () => {};
  let settled: Promise<void> | undefined;
  const prf = randomBytes(32).buffer;
  configureHost(createTestHost({ locks: webLocksDouble() }));
  // Finite authenticator boundary only. No root/admission/provenance hook is replaced:
  // the public store derives KEKs, encrypts wraps, decrypts root and verifies its manifest.
  unlockMethodsSeams.createPasskeyUnlockCeremony =
    async (): Promise<PasskeyCeremony> => ({
      credential: overlapCast({ rawId: randomBytes(16).buffer }),
      prfOutput: prf.slice(0),
      prfSalt: randomBytes(16),
      userId: randomBytes(16),
    });
  unlockMethodsSeams.getPasskeyUnlockCeremony = async () => prf.slice(0);
  try {
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
    await vaultStore.enrollPasskey();
    await vaultStore.flushPendingWrites();
    vaultStore.lock();
    const oldProbe = await vaultStore.probePasskeyCeremony();
    await vaultStore.unlockWithHeldPrf(oldProbe.prfOutput);
    expect(vaultStore.getSnapshot().guest).toBe(false);
    vaultStore.lock();
    let started = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ordinary = unlockMethodsSeams.getPasskeyUnlockCeremony;
    unlockMethodsSeams.getPasskeyUnlockCeremony = async (
      record,
      rpId,
      signal,
    ) => {
      const response = await ordinary(record, rpId, signal);
      started = true;
      await gate;
      return response;
    };
    const verdict = vaultStore.probePasskeyCeremony().then(
      (value) => ({ accepted: true, value }),
      (error) => ({ accepted: false, error }),
    );
    settled = verdict.then(() => {});
    await vi.waitFor(() => expect(started).toBe(true));
    await unlockWithRetiredCredentialGate(vaultStore, retired);
    expect(vaultStore.getSnapshot().guest).toBe(true);
    vaultStore.lock();
    release();
    expect((await verdict).accepted).toBe(false);
    await expect(
      vaultStore.unlockWithHeldPrf(oldProbe.prfOutput),
    ).rejects.toThrow();
    unlockMethodsSeams.getPasskeyUnlockCeremony = ordinary;
    const fresh = await vaultStore.probePasskeyCeremony();
    await vaultStore.unlockWithHeldPrf(fresh.prfOutput);
    expect(vaultStore.getSnapshot().status).toBe("unlocked");
    expect(vaultStore.getSnapshot().guest).toBe(false);
    vaultStore.lock();
    unlockMethodsSeams.getPasskeyUnlockCeremony = async () =>
      randomBytes(32).buffer;
    const wrong = await vaultStore.probePasskeyCeremony();
    await expect(
      vaultStore.unlockWithHeldPrf(wrong.prfOutput),
    ).rejects.toThrow();
    expect(vaultStore.getSnapshot().status).toBe("locked");
    unlockMethodsSeams.getPasskeyUnlockCeremony = async () =>
      new ArrayBuffer(8);
    const malformed = await vaultStore.probePasskeyCeremony();
    await expect(
      vaultStore.unlockWithHeldPrf(malformed.prfOutput),
    ).rejects.toThrow();
    expect(vaultStore.getSnapshot().status).toBe("locked");
  } finally {
    try {
      release();
      await settled;
      Object.assign(unlockMethodsSeams, originalCeremonies);
      await flushRetiredCredentialTelemetry();
      vaultStore.lock();
      if (ownerCreated) {
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
    } finally {
      Object.assign(unlockMethodsSeams, originalCeremonies);
      configureHost(originalHost);
    }
  }
});
