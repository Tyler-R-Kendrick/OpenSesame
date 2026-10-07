import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import { legacyHistoryStore } from "../history-backup-legacy.js";
import { legacyPasswordDigestStore } from "../vault/password-history-legacy.js";
import { freshIndexedDb } from "./edb.test-support.js";
import { createHistoryStore } from "./history-store.js";
import { type EncryptedStores, installEncryptedStores } from "./install.js";
import * as legacyDigests from "./legacy-digests.js";
import * as legacyHistory from "./legacy-history.js";
import { createPasswordDigestStore } from "./password-store.js";

let installed: EncryptedStores | undefined;
beforeEach(() => {
  freshIndexedDb();
});
afterEach(async () => {
  await installed?.uninstall();
  installed = undefined;
  vi.restoreAllMocks();
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const account = (id: string) => ({
  id,
  providerId: "generated-fixture-provider",
  anonToken: crypto.randomUUID(),
  claimState: "provisional" as const,
  createdAt: new Date().toISOString(),
});

it("retains a peer legacy history commit made after the migration snapshot", async () => {
  const peerPut = legacyHistoryStore.putAccount;
  const peerGet = legacyHistoryStore.getAccount;
  const first = account(crypto.randomUUID());
  const second = account(crypto.randomUUID());
  expect(await peerPut(first)).toBe(true);
  const snapshotReady = deferred();
  const resume = deferred();
  const realRead = legacyHistory.readLegacyHistory;
  vi.spyOn(legacyHistory, "readLegacyHistory").mockImplementation(async () => {
    const snapshot = await realRead();
    expect(snapshot?.accounts.map((row) => row.id)).toEqual([first.id]);
    snapshotReady.resolve();
    await resume.promise;
    return snapshot;
  });
  installed = installEncryptedStores();
  await snapshotReady.promise;
  try {
    expect(await peerPut(second)).toBe(true);
    expect(await peerGet(second.id)).toEqual(second);
  } finally {
    resume.resolve();
  }
  await installed.migrated;
  const durable = createHistoryStore();
  expect(await durable.getAccount(first.id)).toEqual(first);
  expect(await durable.getAccount(second.id)).toEqual(second);
});

it("retains a peer legacy password digest committed after the migration snapshot", async () => {
  const peerAdd = legacyPasswordDigestStore.add;
  const peerRead = legacyPasswordDigestStore.digestsFor;
  const scope = `${crypto.randomUUID()}\u0000${crypto.randomUUID()}`;
  const digest = async () =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(crypto.randomUUID()),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  const first = await digest();
  const second = await digest();
  expect(await peerAdd(scope, first)).toBe(true);
  const snapshotReady = deferred();
  const resume = deferred();
  const realRead = legacyDigests.readLegacyDigests;
  vi.spyOn(legacyDigests, "readLegacyDigests").mockImplementation(async () => {
    const snapshot = await realRead();
    expect(snapshot?.map((row) => row.digest)).toEqual([first]);
    snapshotReady.resolve();
    await resume.promise;
    return snapshot;
  });
  installed = installEncryptedStores();
  await snapshotReady.promise;
  try {
    expect(await peerAdd(scope, second)).toBe(true);
    expect(await peerRead(scope)).toContain(second);
  } finally {
    resume.resolve();
  }
  await installed.migrated;
  const durable = createPasswordDigestStore();
  expect(await durable.digestsFor(scope)).toContain(first);
  expect(await durable.digestsFor(scope)).toContain(second);
});
