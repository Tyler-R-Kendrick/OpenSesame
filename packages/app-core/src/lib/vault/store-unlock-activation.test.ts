import { createItem } from "@opensesame/vault-core";
import * as vaultCore from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import * as trustedUnlock from "../trusted-unlock.js";
import { readFile } from "../vfs.js";
import { PASSWORD, newStore } from "./store-ops.fixture.js";
import {
  MARKER,
  MARKER_PATH,
  deferred,
  holdLease,
  holdProjection,
  installUnlockRacesFixture,
  pendingTotp,
  trustedContact,
} from "./store-unlock-races.fixture.js";
import * as sharedLocks from "./vault-shared-locks.js";

installUnlockRacesFixture();

it("cancel during projection synchronously drops the key, decrypted body and VFS custody", async () => {
  const { store, code } = await pendingTotp();
  const held = holdProjection(store);
  const confirm = store.confirmTotp(await code());
  const refused = expect(confirm).rejects.toThrow(/no longer pending/);
  await held.started;
  try {
    store.cancelTotpChallenge();
    expect(store.isUnlocked()).toBe(false);
    expect(store.getSnapshot().status).toBe("locked");
    expect(store.getSnapshot().items).toEqual([]);
    await expect(readFile("personal", MARKER_PATH)).rejects.toMatchObject({
      code: "locked",
    });
  } finally {
    held.release();
    await refused;
  }
});

it.each(["lease", "projection"] as const)(
  "a canceled %s completion preserves a newer session and its destruction lease",
  async (boundary) => {
    const { store, code } = await pendingTotp();
    const held = boundary === "lease" ? holdLease() : holdProjection(store);
    const old = store.confirmTotp(await code());
    const refused = expect(old).rejects.toThrow(/no longer pending/);
    await held.started;
    try {
      store.cancelTotpChallenge();
      await store.unlock(PASSWORD);
      await store.confirmTotp(await code());
      held.release();
      await refused;
      expect(store.isUnlocked()).toBe(true);
      await store.saveItem(createItem("note", "New session remains usable"));
      expect(
        new TextDecoder().decode(await readFile("personal", MARKER_PATH)),
      ).toBe(MARKER);
      const other = newStore();
      await expect(other.destroy()).rejects.toThrow(/changed in another tab/);
      expect(store.isUnlocked()).toBe(true);
      store.lock();
      await other.destroy();
    } finally {
      held.release();
      await refused;
    }
  },
);

it("lock during a completed trusted-policy read cannot restore the key or sealed files", async () => {
  const { store, code } = await pendingTotp();
  const started = deferred();
  const gate = deferred();
  const read = trustedUnlock.readTrustedUnlock;
  vi.spyOn(trustedUnlock, "readTrustedUnlock").mockImplementationOnce(
    async (...args) => {
      const policy = await read(...args);
      started.release();
      await gate.promise;
      return policy;
    },
  );
  const refused = expect(store.confirmTotp(await code())).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    store.lock();
    gate.release();
    await refused;
    expect(store.isUnlocked()).toBe(false);
    await expect(readFile("personal", MARKER_PATH)).rejects.toMatchObject({
      code: "locked",
    });
  } finally {
    gate.release();
    await refused;
  }
});

it("a real trusted-contact approval remains cancelable through final activation", async () => {
  const { store, code } = await pendingTotp();
  const person = await trustedContact(store, code);
  const held = holdProjection(store);
  const refused = expect(store.confirmTrustedContact(person)).rejects.toThrow(
    /no longer pending/,
  );
  await held.started;
  try {
    store.cancelTrustedUnlock();
    expect(store.isUnlocked()).toBe(false);
    expect(store.getSnapshot().items).toEqual([]);
    await expect(readFile("personal", MARKER_PATH)).rejects.toMatchObject({
      code: "locked",
    });
  } finally {
    held.release();
    await refused;
  }
});

it("concurrent real contact approvals activate once and release every destruction lease", async () => {
  const { store, code } = await pendingTotp();
  const person = await trustedContact(store, code);
  const firstProof = deferred();
  const bothProofs = deferred();
  const proofGate = deferred();
  const authenticate = trustedUnlock.trustedUnlockSeams.authenticate;
  let proofs = 0;
  vi.spyOn(trustedUnlock.trustedUnlockSeams, "authenticate").mockImplementation(
    async (...args) => {
      await authenticate(...args);
      if (++proofs === 1) firstProof.release();
      if (proofs === 2) bothProofs.release();
      await proofGate.promise;
    },
  );
  const held = holdLease();
  const first = store.confirmTrustedContact(person);
  const results = Promise.allSettled([
    first,
    (async () => {
      await firstProof.promise;
      return store.confirmTrustedContact(person);
    })(),
  ]);
  try {
    await bothProofs.promise;
    proofGate.release();
    await held.started;
    expect(sharedLocks.acquireOpenLease).toHaveBeenCalledTimes(1);
    held.release();
    const outcomes = await results;
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(store.isUnlocked()).toBe(true);
    store.lock();
    await held.released;
    await newStore().destroy();
  } finally {
    proofGate.release();
    held.release();
    await results;
  }
});

it("a late completion cannot lock or clear the newly selected guest scope", async () => {
  const { store, code } = await pendingTotp();
  const held = holdProjection(store);
  const refused = expect(store.confirmTotp(await code())).rejects.toThrow(
    /no longer pending/,
  );
  await held.started;
  try {
    store.lock();
    store.prepareGuestUnlock();
    await store.createGuest();
    const guest = store.activeTomb();
    expect(guest).not.toBe("personal");
    await store.saveItem(createItem("note", "Guest scope survives"));
    held.release();
    await refused;
    expect(store.activeTomb()).toBe(guest);
    expect(store.isUnlocked()).toBe(true);
    expect(store.getSnapshot().items.map((item) => item.name)).toEqual([
      "Guest scope survives",
    ]);
    await store.saveItem(createItem("note", "Still writable"));
    await expect(readFile("personal", MARKER_PATH)).rejects.toMatchObject({
      code: "locked",
    });
  } finally {
    held.release();
    await refused;
  }
});

it("a queued lock at the policy-read boundary precedes any key publication", async () => {
  const { store, code } = await pendingTotp();
  const read = trustedUnlock.readTrustedUnlock;
  vi.spyOn(trustedUnlock, "readTrustedUnlock").mockImplementationOnce(
    async (...args) => {
      const policy = await read(...args);
      queueMicrotask(() => store.lock());
      return policy;
    },
  );
  await expect(store.confirmTotp(await code())).rejects.toThrow(
    /no longer pending/,
  );
  expect(store.isUnlocked()).toBe(false);
  await expect(readFile("personal", MARKER_PATH)).rejects.toMatchObject({
    code: "locked",
  });
});

it("cancel still wipes the retained primary root before key import returns", async () => {
  const { store } = await pendingTotp();
  store.cancelTotpChallenge();
  const started = deferred();
  const gate = deferred();
  const importKey = vaultCore.importVaultKey;
  const retained: Uint8Array[] = [];
  vi.spyOn(vaultCore, "importVaultKey").mockImplementationOnce(async (raw) => {
    const key = await importKey(raw);
    retained.push(raw);
    started.release();
    await gate.promise;
    return key;
  });
  const refused = expect(store.unlock(PASSWORD)).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    store.cancelTotpChallenge();
    expect(store.isUnlocked()).toBe(false);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.every((byte) => byte === 0)).toBe(true);
    await expect(readFile("personal", MARKER_PATH)).rejects.toMatchObject({
      code: "locked",
    });
  } finally {
    gate.release();
    await refused;
  }
});
