/**
 * What a destroyed vault leaves behind (ADR 0162). Everything sealed under a
 * key that is gone is unreadable ciphertext, and a fresh vault in the same
 * tomb (a guest's, the next one) has a key that cannot open it. So every file
 * the device writes for its person is wiped with the vault, receipts and the
 * audit of connector grants among them, and the next vault starts clean.
 */

import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import {
  listReceipts,
  pendingReceipts,
  recordReceipt,
  resetHeldReceiptsForTest,
} from "../device-receipts.js";
import { kvGet } from "../kv.js";
import {
  listAccessAuditEvents,
  recordAccessAuditEvent,
} from "../local-access-audit.js";
import {
  readPreference,
  writePreference,
} from "../local-notifications/preference.js";
import {
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "../vfs.js";
import { wipeTombOnDestroy } from "./tomb-migration.js";

const APP = "local_11111111-1111-4111-8111-111111111111";
let tomb: string;

beforeEach(async () => {
  tomb = `wipe-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
});
afterEach(() => {
  resetHeldReceiptsForTest();
  lockAllTombs();
  vi.unstubAllGlobals();
});

const PATHS = [
  "config/device-receipts",
  "config/device-receipts-pending",
  "config/access-audit",
  "config/local-notifications",
];

/** Everything this device writes for its person, in one tomb. */
async function leaveTheDevicesFiles() {
  await recordReceipt(tomb, "request.created", { applicationId: APP });
  await recordAccessAuditEvent(tomb, {
    eventType: "access.connection.revoked",
    outcome: "succeeded",
    targetType: "connection",
    targetId: "slack",
    metadata: { subject: "agent", policy: "use" },
  });
  await writePreference(tomb, { version: 1, destinations: ["in_app"] });
  await writeFile(
    tomb,
    "config/device-receipts-pending",
    new TextEncoder().encode('{"version":1,"receipts":[]}'),
  );
}

it("wipes every file the device wrote for its person with the vault", async () => {
  await leaveTheDevicesFiles();
  for (const path of PATHS)
    expect(kvGet(tombFileKey(tomb, path)), path).not.toBeNull();
  await wipeTombOnDestroy(tomb);
  for (const path of PATHS)
    expect(kvGet(tombFileKey(tomb, path)), path).toBeNull();
});

it("a sealed write still in flight does not reseal the index after the wipe", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seal = vfsSeams.seal;
  let reached = false;
  vfsSeams.seal = async (...args) => {
    reached = true;
    await gate;
    return seal(...args);
  };
  try {
    const pending = writeFile(
      tomb,
      "config/activity-log",
      new TextEncoder().encode("still-sealing"),
    );
    for (let i = 0; i < 20 && !reached; i++) await Promise.resolve();
    expect(reached).toBe(true);
    const wiping = wipeTombOnDestroy(tomb);
    release();
    await wiping;
    await pending.catch(() => undefined);
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    await writeFile(
      tomb,
      "config/activity-log",
      new TextEncoder().encode("next-vault"),
    );
  } finally {
    vfsSeams.seal = seal;
    release();
  }
});

it("lets a vault made in the same tomb afterwards read, record and list as new", async () => {
  await leaveTheDevicesFiles();
  await wipeTombOnDestroy(tomb);
  // A new key, as a new guest has: the old ciphertext, had it stayed, would
  // not open under it.
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  expect(await listReceipts(tomb, 10)).toEqual([]);
  expect(await listAccessAuditEvents(tomb)).toEqual([]);
  expect(await readPreference(tomb)).toMatchObject({ version: 1 });
  await recordReceipt(tomb, "request.denied", { applicationId: APP });
  expect((await listReceipts(tomb, 10)).map((row) => row.eventType)).toEqual([
    "access.request.denied",
  ]);
  expect(await pendingReceipts(tomb)).toBe(0);
});
