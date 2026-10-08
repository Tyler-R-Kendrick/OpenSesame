import { expect, it } from "vitest";
import { configureHost, host } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { kvDelete } from "../kv.js";
import { enrollRetiredCredential } from "../retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "../retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import { clearVaultSurface } from "../vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "../vault/store.js";
import { tombFileKey } from "../vfs.js";
import { PAIRING, memoryDrive } from "./drive.fixture.js";
import { networkAccessSeams } from "./network-access.js";
import {
  pairTailnetDrive,
  stopTailnetSync,
  tailnetSyncSeams,
} from "./observer.js";
import { formatPairingCode } from "./pairing.js";

it("tailnet pairing cannot consume a successor owner after a held browser permission answer", async () => {
  const originalHost = host();
  const originalQuery = networkAccessSeams.query;
  const originalSeams = { ...tailnetSyncSeams };
  const password = "permission-original-owner-password";
  const retired = "permission-retired-password";
  let created = false;
  let resume = () => {};
  let finished: Promise<void> | undefined;
  configureHost(createTestHost({ locks: webLocksDouble() }));
  try {
    await clearVaultSurface();
    kvDelete(tombFileKey("personal", "retired-credentials.v1"));
    await vaultStore.create(password);
    created = true;
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: password,
      retiredPassword: retired,
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
    const drive = memoryDrive();
    let reaches = 0;
    Object.assign(tailnetSyncSeams, {
      transport: drive,
      reach: async () => {
        reaches += 1;
      },
    });
    networkAccessSeams.query = async () => "granted";
    expect(await pairTailnetDrive(formatPairingCode(PAIRING))).toBe("paired");
    const written = drive.writes;
    const reached = reaches;
    let started = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    networkAccessSeams.query = async () => {
      started();
      await barrier;
      return "granted";
    };
    const pending = pairTailnetDrive(formatPairingCode(PAIRING)).then(
      (value) => ({ accepted: true as const, value }),
      (error) => ({ accepted: false as const, error }),
    );
    finished = pending.then(() => {});
    await entered;
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
    vaultStore.lock();
    resume();
    expect((await pending).accepted).toBe(false);
    expect(drive.writes).toBe(written);
    expect(reaches).toBe(reached);
    await vaultStore.unlock(password);
    networkAccessSeams.query = async () => "granted";
    expect(await pairTailnetDrive(formatPairingCode(PAIRING))).toBe("paired");
  } finally {
    resume();
    try {
      await finished;
      stopTailnetSync();
      await flushRetiredCredentialTelemetry();
      if (created) {
        vaultStore.lock();
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
    } finally {
      stopTailnetSync();
      networkAccessSeams.query = originalQuery;
      Object.assign(tailnetSyncSeams, originalSeams);
      configureHost(originalHost);
    }
  }
});
