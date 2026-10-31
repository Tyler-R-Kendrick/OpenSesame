import { expect, it, vi } from "vitest";
import { readFile } from "../vfs.js";
import * as recovery from "./recovery-codes.js";
import { PENDING_CHALLENGE_MS } from "./second-step-guard.js";
import { PASSWORD } from "./store-ops.fixture.js";
import {
  MARKER_PATH,
  deferred,
  holdProjection,
  installUnlockRacesFixture,
  pendingRemote,
  pendingTotp,
} from "./store-unlock-races.fixture.js";
import * as unlockMethods from "./unlock-methods.js";

installUnlockRacesFixture();

it("a stale verified remote response cannot replace a later valid session", async () => {
  const { store, verification, verify, code } = await pendingRemote();
  const started = deferred();
  const gate = deferred();
  verification.mockImplementationOnce(async (id, value) => {
    await verify(id, value);
    started.release();
    await gate.promise;
  });
  const refused = expect(store.confirmRemoteCode(code)).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    store.cancelTotpChallenge();
    await store.unlock(PASSWORD);
    await store.requestSecondStepCode("email");
    await store.confirmRemoteCode(code);
    gate.release();
    await refused;
    expect(store.isUnlocked()).toBe(true);
    expect(store.getSnapshot().failedAttempts).toBe(0);
  } finally {
    gate.release();
    await refused;
  }
});

it("remote verification that finishes after expiry cannot regain custody", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { store, verification, verify, code } = await pendingRemote();
  const started = deferred();
  const gate = deferred();
  verification.mockImplementationOnce(async (id, value) => {
    await verify(id, value);
    started.release();
    await gate.promise;
  });
  const refused = expect(store.confirmRemoteCode(code)).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    vi.advanceTimersByTime(PENDING_CHALLENGE_MS + 1);
    expect(store.getSnapshot().awaitingSecondStep).toBe(false);
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

it("expiry during final projection synchronously drops the provisional key and body", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { store, code } = await pendingTotp();
  const held = holdProjection(store);
  const refused = expect(store.confirmTotp(await code())).rejects.toThrow(
    /no longer pending/,
  );
  await held.started;
  try {
    vi.advanceTimersByTime(PENDING_CHALLENGE_MS + 1);
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

it("a spent recovery proof cannot finish after its original challenge was canceled", async () => {
  const { store, codes } = await pendingTotp(true);
  const code = codes[0];
  if (!code) throw new Error("No recovery fixture code");
  const started = deferred();
  const gate = deferred();
  const spend = recovery.spendRecoveryCode;
  vi.spyOn(recovery, "spendRecoveryCode").mockImplementationOnce(
    async (...args) => {
      const next = await spend(...args);
      started.release();
      await gate.promise;
      return next;
    },
  );
  const refused = expect(store.redeemRecoveryCode(code)).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    store.cancelTotpChallenge();
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

it("a stale recovery mismatch cannot consume a newer session's attempt budget", async () => {
  const { store, code } = await pendingTotp(true);
  const started = deferred();
  const gate = deferred();
  const read = unlockMethods.openRecoveryLedger;
  vi.spyOn(unlockMethods, "openRecoveryLedger").mockImplementationOnce(
    async (...args) => {
      const ledger = await read(...args);
      started.release();
      await gate.promise;
      return ledger;
    },
  );
  const refused = expect(
    store.redeemRecoveryCode("not a recovery code"),
  ).rejects.toThrow(/no longer pending/);
  await started.promise;
  try {
    store.cancelTotpChallenge();
    await store.unlock(PASSWORD);
    await store.confirmTotp(await code());
    gate.release();
    await refused;
    expect(store.isUnlocked()).toBe(true);
    expect(store.getSnapshot().failedAttempts).toBe(0);
  } finally {
    gate.release();
    await refused;
  }
});
