import { overlapCast } from "@opensesame/os-domain";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import {
  clearCaches,
  clearOriginFiles,
  unregisterServiceWorkers,
  unsubscribePush,
} from "./browser-reset-areas.js";
import {
  SCOPE,
  cacheStore,
  memoryStorage,
  ownsCache,
  registration,
  workerContainer,
} from "./browser-reset.fixture.js";
import { resetBrowser } from "./browser-reset.js";
import { currentRealmGeneration, isDecoySession } from "./decoy-session.js";
import { clearActivePresentation } from "./duress/compartment/presentation-runtime.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import { createHistoryStore } from "./encrypted-db/history-store.js";
import {
  type EncryptedStores,
  installEncryptedStores,
} from "./encrypted-db/install.js";
import { putHistoryAccount } from "./history-backup-idb.js";
import { kvFlush, kvForgetAll } from "./kv.js";
import {
  enrollRetiredCredential,
  flushRetiredCredentialTelemetry,
} from "./retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";
import { resumeStorageWritesForTest } from "./storage-halt.js";
import { vaultStore } from "./vault/store.js";

let factory: IDBFactory;
let installed: EncryptedStores | undefined;
let ownerPassword: string;
let retiredPassword: string;
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  await flushRetiredCredentialTelemetry();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  resumeStorageWritesForTest();
  factory = new IDBFactory();
  const root = makeOpfs();
  const locks = webLocksDouble();
  const key = crypto.getRandomValues(new Uint8Array(32));
  configureHost(
    createTestHost({
      storage: { local: memoryStorage(), session: memoryStorage() },
      originFiles: async () => overlapCast(root),
      locks,
      indexedDB: factory,
      keyRange: IDBKeyRange,
      atRestKeys: { loadSync: () => key, load: async () => key },
      environment: {
        online: false,
        userAgent: "generated-fixture",
        userActivated: false,
        workers: { dedicated: false, shared: false, service: false },
        onOnlineChange: () => () => {},
      },
    }),
  );
  vaultStore.rehydrate();
  ownerPassword = crypto.randomUUID();
  retiredPassword = crypto.randomUUID();
  await vaultStore.create(ownerPassword);
  vaultStore.lock();
  await vaultStore.unlock(ownerPassword);
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: ownerPassword,
    retiredPassword,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  installed = installEncryptedStores();
  await installed.migrated;
  await putHistoryAccount({
    id: crypto.randomUUID(),
    providerId: "generated-fixture",
    anonToken: crypto.randomUUID(),
    claimState: "provisional",
    createdAt: new Date().toISOString(),
  });
  expect(await createHistoryStore().listAccounts()).toHaveLength(1);
  vaultStore.lock();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await installed?.uninstall();
  installed = undefined;
  vaultStore.lock();
  await flushRetiredCredentialTelemetry();
  clearActivePresentation();
  resumeStorageWritesForTest();
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
});

it("opens an actual retired synthetic session outside browser reset", async () => {
  await expect(
    unlockWithRetiredCredentialGate(vaultStore, retiredPassword),
  ).resolves.toBe("retired_credential_session");
  expect(vaultStore.getSnapshot()).toMatchObject({
    status: "unlocked",
    decoy: true,
  });
});

it("finishes an unchanged-realm browser reset through the real caller", async () => {
  const report = await resetBrowser({ scope: SCOPE, ownsCache });
  expect(report.cleared).toContain("databases");
  expect((await factory.databases()).map((entry) => entry.name)).toEqual([]);
});

it("refuses stale reset dispatch after public lock keeps real presentation", async () => {
  const listingReached = deferred();
  const resumeListing = deferred();
  const realDatabases = factory.databases.bind(factory);
  vi.spyOn(factory, "databases").mockImplementation(async () => {
    const listed = await realDatabases();
    listingReached.resolve();
    await resumeListing.promise;
    return listed;
  });
  const deletes = vi.spyOn(factory, "deleteDatabase");
  const resetting = resetBrowser({ scope: SCOPE, ownsCache });
  await listingReached.promise;
  const originalRealm = currentRealmGeneration();
  vaultStore.lock();
  expect(isDecoySession()).toBe(false);
  expect(currentRealmGeneration()).not.toBe(originalRealm);
  resumeListing.resolve();
  const report = await resetting;
  expect(deletes).not.toHaveBeenCalled();
  expect(report.failed).toContain("databases");
});

it.each([
  "origin-files",
  "cache-keys",
  "push-registrations",
  "push-subscription",
  "worker-registrations",
] as const)(
  "refuses a stale %s destructive continuation after public lock",
  async (area) => {
    const reached = deferred();
    const resume = deferred();
    const hold = async <T>(actual: Promise<T>) => {
      const value = await actual;
      reached.resolve();
      await resume.promise;
      return value;
    };
    let checkDispatch: () => void;
    let work: () => Promise<void>;
    if (area === "origin-files") {
      const readRoot = host().originFiles;
      if (!readRoot) throw new Error("Expected actual OPFS fixture");
      const root = await readRoot();
      const remove = vi.spyOn(root, "removeEntry");
      vi.spyOn(host(), "originFiles").mockImplementation(() =>
        hold(readRoot()),
      );
      work = clearOriginFiles;
      checkDispatch = () => expect(remove).not.toHaveBeenCalled();
    } else if (area === "cache-keys") {
      const cache = cacheStore(["opensesame-pages:/OpenSesame/:r1:core-only"]);
      configureHost({ ...host(), cacheStorage: cache.port });
      const keys = cache.port.keys.bind(cache.port);
      vi.spyOn(cache.port, "keys").mockImplementation(() => hold(keys()));
      const remove = vi.spyOn(cache.port, "delete");
      work = () => clearCaches(ownsCache);
      checkDispatch = () => expect(remove).not.toHaveBeenCalled();
    } else {
      const registered = registration(SCOPE, { subscribed: true });
      const container = workerContainer(registered);
      configureHost({ ...host(), serviceWorker: container });
      if (area === "push-subscription") {
        const get = registered.value.pushManager.getSubscription;
        vi.spyOn(
          registered.value.pushManager,
          "getSubscription",
        ).mockImplementation(() => hold(get()));
      } else {
        const get = container.getRegistrations.bind(container);
        vi.spyOn(container, "getRegistrations").mockImplementation(() =>
          hold(get()),
        );
      }
      const worker = area === "worker-registrations";
      work = () =>
        worker ? unregisterServiceWorkers(SCOPE) : unsubscribePush(SCOPE);
      checkDispatch = () =>
        expect(
          worker ? registered.unregister : registered.unsubscribe,
        ).not.toHaveBeenCalled();
    }
    const pending = work().then(
      () => null,
      (error: Error) => error,
    );
    await reached.promise;
    checkDispatch();
    const originalRealm = currentRealmGeneration();
    vaultStore.lock();
    expect(isDecoySession()).toBe(false);
    expect(currentRealmGeneration()).not.toBe(originalRealm);
    resume.resolve();
    const result = await pending;
    checkDispatch();
    expect(result).toBeInstanceOf(Error);
  },
);

it("refuses late reset database dispatch if a genuine retired continuation changes the realm", async () => {
  const createReached = deferred();
  const resumeCreate = deferred();
  const realCreate = vaultStore.createGuest.bind(vaultStore);
  vi.spyOn(vaultStore, "createGuest").mockImplementation(async (options) => {
    createReached.resolve();
    await resumeCreate.promise;
    return realCreate(options);
  });
  const unlocking = unlockWithRetiredCredentialGate(
    vaultStore,
    retiredPassword,
  ).then(
    (result) => ({ kind: "opened" as const, result }),
    (error) => ({ kind: "rejected" as const, error }),
  );
  await createReached.promise;
  const realmBeforeReset = currentRealmGeneration();
  const listingReached = deferred();
  const resumeListing = deferred();
  const realDatabases = factory.databases.bind(factory);
  vi.spyOn(factory, "databases").mockImplementation(async () => {
    const listed = await realDatabases();
    listingReached.resolve();
    await resumeListing.promise;
    return listed;
  });
  const deletes = vi.spyOn(factory, "deleteDatabase");
  const resetting = resetBrowser({ scope: SCOPE, ownsCache });
  await listingReached.promise;
  expect(deletes).not.toHaveBeenCalled();
  resumeCreate.resolve();
  const outcome = await unlocking;
  const syntheticAtDispatch = isDecoySession();
  const realmAtDispatch = currentRealmGeneration();
  resumeListing.resolve();
  const report = await resetting;
  if (syntheticAtDispatch) {
    expect(outcome.kind).toBe("rejected");
    expect(realmAtDispatch).not.toBe(realmBeforeReset);
    expect(deletes).not.toHaveBeenCalled();
    expect(report.failed).toContain("databases");
  } else {
    // An actual caller cancellation that excludes entry closes this candidate.
    expect(outcome.kind).toBe("rejected");
    expect(report.cleared).toContain("databases");
  }
});
