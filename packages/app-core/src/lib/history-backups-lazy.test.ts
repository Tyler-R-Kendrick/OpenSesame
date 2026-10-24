/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type {
  HistoryRowStore,
  ProvisionalHistoryAccount,
} from "./history-backup-types.js";
function deferred() {
  let complete: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, release: () => complete() };
}
const account = (): ProvisionalHistoryAccount => ({
  id: "history-original",
  providerId: "neon",
  anonToken: "original-opaque-credential",
  claimState: "provisional",
  createdAt: "2026-10-24T00:00:00Z",
});
function installed(rows: ProvisionalHistoryAccount[] = []) {
  const written = new Map(rows.map((row) => [row.id, row]));
  const store: HistoryRowStore = {
    putAccount: vi.fn(async (value) => {
      written.set(value.id, value);
      return true as const;
    }),
    getAccount: vi.fn(async (id) => written.get(id)),
    listAccounts: vi.fn(async () => [...written.values()]),
    listEntries: vi.fn(async () => []),
    holdsAnyEntry: vi.fn(async () => false),
    putEntry: vi.fn(async () => true as const),
  };
  return { store, written };
}
const tasks: Promise<unknown>[] = [];
let active: Awaited<ReturnType<typeof setup>> | undefined;
async function setup() {
  vi.resetModules();
  const gate = deferred();
  const seen = deferred();
  let loads = 0;
  let handoff: (() => void) | undefined;
  const { configureHost } = await import("../host.js");
  const { createTestHost } = await import("../test-host.js");
  const key = await import("./at-rest/key.js");
  configureHost(createTestHost());
  key.forgetAtRestKeyForTest();
  const idb = await import("./history-backup-idb.js");
  const history = await import("./history-backups.js");
  const originalLoad = idb.historyActionLoading.load;
  idb.historyActionLoading.load = async () => {
    loads += 1;
    seen.release();
    await gate.promise;
    const actual = await originalLoad();
    return {
      ...actual,
      get legacyHistoryStore() {
        if (handoff) queueMicrotask(handoff);
        return actual.legacyHistoryStore;
      },
      get bindLegacyHistoryStore() {
        if (handoff) queueMicrotask(handoff);
        return actual.bindLegacyHistoryStore;
      },
    };
  };
  const state = {
    gate,
    seen,
    idb,
    history,
    key,
    configureHost,
    createTestHost,
    originalLoad,
    loads: () => loads,
    atHandoff: (next: () => void) => {
      handoff = next;
    },
  };
  active = state;
  return state;
}
afterEach(async () => {
  active?.gate.release();
  await Promise.allSettled(tasks.splice(0));
  active?.idb.installHistoryRowStore(null);
  active?.idb.resetHistoryBackupMemory();
  if (active) active.idb.historyActionLoading.load = active.originalLoad;
  active?.key.forgetAtRestKeyForTest();
  active?.configureHost(active.createTestHost());
  active = undefined;
  vi.restoreAllMocks();
});
function track<T>(task: Promise<T>): Promise<T> {
  tasks.push(task.catch(() => undefined));
  return task;
}
it("guest-auth and connect-roads can read shared group/selection metadata without loading claim/storage actions", async () => {
  const state = await setup();
  await import("./guest-auth.js");
  const roads = await import("./connect-roads.js");
  expect(state.history.HISTORY_BACKUP_GROUPS[0]?.providerIds).toContain(
    "gitlab",
  );
  expect(roads.connectorActs({ id: "git" }, true)).toBe(true);
  await state.history.toggleHistoryProvider("gitlab");
  expect(state.history.isHistorySelected("gitlab")).toBe(true);
  expect(state.loads()).toBe(0);
});
it("an actual successful guest link captures its original claim store before the held implementation load", async () => {
  const state = await setup();
  const first = installed([account()]);
  const later = installed();
  state.idb.installHistoryRowStore(first.store);
  const guest = await import("./guest-auth.js");
  const linked = vi.fn(async () => ({}));
  Object.assign(guest.guestAuthDependencies, {
    currentSession: () => ({
      principalId: "prn-linked-owner",
      accessToken: "fixture-principal-session",
      issuerOrigin: "https://identity.example.test",
    }),
    identityJson: linked,
  });
  const pending = track(guest.linkGuestAccount("verified-upstream-assertion"));
  await state.seen.promise;
  expect(linked).toHaveBeenCalledWith(
    "/v1/principals/link-identities",
    expect.objectContaining({ method: "POST" }),
  );
  expect(first.store.listAccounts).toHaveBeenCalledTimes(1);
  state.idb.installHistoryRowStore(later.store);
  const original = first.written.get("history-original");
  if (original) original.anonToken = "changed-while-code-was-held";
  state.gate.release();
  await pending;
  expect(first.written.get("history-original")).toMatchObject({
    claimState: "claimed",
    principalId: "prn-linked-owner",
    anonToken: "original-opaque-credential",
  });
  expect(later.store.listAccounts).not.toHaveBeenCalled();
  expect(later.store.putAccount).not.toHaveBeenCalled();
});
it("a rejected guest identity link performs no claim or history implementation load", async () => {
  const state = await setup();
  const first = installed([account()]);
  state.idb.installHistoryRowStore(first.store);
  const guest = await import("./guest-auth.js");
  Object.assign(guest.guestAuthDependencies, {
    currentSession: () => ({
      principalId: "prn-refused",
      accessToken: "fixture-principal-session",
      issuerOrigin: "https://identity.example.test",
    }),
    identityJson: async () => {
      throw new Error("Upstream link refused");
    },
  });
  await expect(guest.linkGuestAccount("refused-assertion")).rejects.toThrow(
    "Upstream link refused",
  );
  expect(first.store.listAccounts).not.toHaveBeenCalled();
  expect(first.written.get("history-original")?.claimState).toBe("provisional");
  expect(state.loads()).toBe(0);
});
it("a held legacy write retains its selected store and credential bytes, then cold-reads the actual sealed account and snapshot", async () => {
  const state = await setup();
  const { fakeIndexedDb, rawRows } = await import(
    "./at-rest/fake-idb.test-support.js"
  );
  const { HISTORY_BACKUP_DATABASE } = await import("./storage-ownership.js");
  const { factory, databases } = fakeIndexedDb();
  state.configureHost(state.createTestHost({ indexedDB: factory }));
  const selected = account();
  const put = track(state.idb.putHistoryAccount(selected));
  selected.anonToken = "changed-after-invocation";
  await state.seen.promise;
  const later = installed();
  state.idb.installHistoryRowStore(later.store);
  state.gate.release();
  await put;
  expect(later.store.putAccount).not.toHaveBeenCalled();
  const sealed = rawRows(databases, HISTORY_BACKUP_DATABASE, "accounts");
  expect(sealed).toHaveLength(1);
  expect(sealed[0]?.sealed).toEqual(expect.any(String));
  expect(JSON.stringify(sealed)).not.toContain("original-opaque-credential");
  state.idb.installHistoryRowStore(null);
  const bytes = new Uint8Array([1, 2, 3]);
  const append = track(state.idb.appendHistoryEntry(selected.id, bytes));
  bytes.fill(9);
  await append;
  state.idb.resetHistoryBackupMemory();
  expect((await state.idb.listHistoryAccounts())[0]?.anonToken).toBe(
    "original-opaque-credential",
  );
  expect(
    (await state.idb.listHistoryEntries(selected.id))[0]?.ciphertextB64,
  ).toBe("AQID");
});
it("reset during an actual held implementation load denies late writes rather than repopulating a new store", async () => {
  const state = await setup();
  const { fakeIndexedDb } = await import("./at-rest/fake-idb.test-support.js");
  const { factory } = fakeIndexedDb();
  state.configureHost(state.createTestHost({ indexedDB: factory }));
  const put = track(state.idb.putHistoryAccount(account()));
  await state.seen.promise;
  state.idb.resetHistoryBackupMemory();
  const refused = expect(put).rejects.toThrow(
    "history storage operation ended",
  );
  state.gate.release();
  await refused;
  expect(await state.idb.listHistoryAccounts()).toEqual([]);
});
it("a different at-rest key cannot be adopted while an original legacy request waits on code", async () => {
  const state = await setup();
  const put = track(state.idb.putHistoryAccount(account()));
  await state.seen.promise;
  state.key.forgetAtRestKeyForTest();
  state.configureHost(state.createTestHost());
  await state.key.atRestReady();
  const refused = expect(put).rejects.toThrow(
    "history storage operation ended",
  );
  state.gate.release();
  await refused;
});

it("a held legacy load cannot write its original credentials into a replacement host database", async () => {
  const state = await setup();
  const { fakeIndexedDb } = await import("./at-rest/fake-idb.test-support.js");
  const first = fakeIndexedDb();
  const later = fakeIndexedDb();
  state.configureHost(state.createTestHost({ indexedDB: first.factory }));
  const put = track(state.idb.putHistoryAccount(account()));
  await state.seen.promise;
  state.configureHost(state.createTestHost({ indexedDB: later.factory }));
  const refused = expect(put).rejects.toThrow(
    "history storage operation ended",
  );
  state.gate.release();
  await refused;
  expect(first.databases.size).toBe(0);
  expect(later.databases.size).toBe(0);
});

it.each(["reset", "key", "database"] as const)(
  "rechecks %s custody in the promise reaction immediately before delegating a resolved legacy store",
  async (change) => {
    const state = await setup();
    const { fakeIndexedDb, rawRows } = await import(
      "./at-rest/fake-idb.test-support.js"
    );
    const { HISTORY_BACKUP_DATABASE } = await import("./storage-ownership.js");
    const original = fakeIndexedDb();
    const replacement = fakeIndexedDb();
    state.configureHost(state.createTestHost({ indexedDB: original.factory }));
    // The actual export is resolved while loading is held. Its handoff queues a
    // custody change ahead of the native Promise reaction that invokes the store.
    state.atHandoff(() => {
      if (change === "reset") state.idb.resetHistoryBackupMemory();
      else if (change === "key") {
        state.key.forgetAtRestKeyForTest();
        void state.key.atRestReady();
      } else
        state.configureHost(
          state.createTestHost({ indexedDB: replacement.factory }),
        );
    });
    const task = track(state.idb.putHistoryAccount(account()));
    await state.seen.promise;
    const refused = expect(task).rejects.toThrow(
      "history storage operation ended",
    );
    state.gate.release();
    await refused;
    expect(
      rawRows(original.databases, HISTORY_BACKUP_DATABASE, "accounts"),
    ).toEqual([]);
    expect(
      rawRows(replacement.databases, HISTORY_BACKUP_DATABASE, "accounts"),
    ).toEqual([]);
  },
);
