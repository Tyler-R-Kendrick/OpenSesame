import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertNotDecoySession, markDecoySession } from "../decoy-session.js";
import { clearActivePresentation } from "../duress/compartment/presentation-runtime.js";
import { kvGet } from "../kv.js";
import { vaultIdentity } from "../vault/store-vault-identity.js";
import {
  clearRetiredCredentialEvents,
  probeRetiredCredential,
  removeRetiredCredential,
  retiredCredentialStatus,
  retiredCredentialStorageSeams,
} from "./index.js";
import {
  authenticateRetiredCredentialOwner,
  verifyCurrentCredential,
  withAuthenticatedRetiredCredentialOwner,
} from "./owner-auth.js";
import { persistAuthenticatedRecords } from "./owner-records.js";
import type { Records } from "./records.js";
import { openRetiredCredentialDecoy } from "./session.js";
import {
  PASSWORD,
  TRAPS_KEY,
  createRetiredCredentialFixture,
} from "./test-support.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  await fixture.enroll("first-retired-loader-password");
  await probeRetiredCredential("first-retired-loader-password", "personal");
  // Exercise the actual cached module's asynchronous yield, without module mocks.
  await import("./owner-operations.js");
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.restore();
  clearActivePresentation();
});

function retireOwner(synthetic: boolean): void {
  if (!synthetic) fixture.store.lock();
  else {
    const identity = vaultIdentity(fixture.store.getSnapshot().header);
    if (!identity)
      throw new Error("The genuine owner must have a vault identity.");
    markDecoySession(true, "personal", identity);
    markDecoySession(false);
  }
}

it.each([
  ["authenticate", false],
  ["authenticate", true],
  ["verify", false],
  ["verify", true],
  ["commit", false],
  ["commit", true],
  ["persist", false],
  ["persist", true],
] as const)(
  "does not read or commit across the cached %s proof loader (synthetic=%s)",
  async (operation, synthetic) => {
    const before = kvGet(TRAPS_KEY);
    const ownerHeader = fixture.store.getSnapshot().header;
    const generation = assertNotDecoySession();
    const refresh = vi.fn(async () => {});
    const storageRefresh = vi.spyOn(retiredCredentialStorageSeams, "refresh");
    const commit = vi.fn(async () => {});
    const records: Records = JSON.parse(before ?? "{}");
    const operations = {
      authenticate: () =>
        authenticateRetiredCredentialOwner("personal", PASSWORD, refresh),
      verify: () => verifyCurrentCredential("personal", PASSWORD, refresh),
      commit: () =>
        withAuthenticatedRetiredCredentialOwner(
          "personal",
          PASSWORD,
          commit,
          refresh,
        ),
      persist: () =>
        persistAuthenticatedRecords(
          { tomb: "personal", currentPassword: PASSWORD },
          records,
          generation,
        ),
    };
    const pending = operations[operation]().then(
      () => null,
      (error: Error) => error,
    );
    retireOwner(synthetic);
    expect(await pending).toBeInstanceOf(Error);
    expect(refresh).not.toHaveBeenCalled();
    expect(storageRefresh).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(kvGet(TRAPS_KEY)).toBe(before);
    expect(() => assertNotDecoySession(generation)).toThrow();
    expect(fixture.store.getSnapshot().header).toBe(
      synthetic ? null : ownerHeader,
    );
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "locked",
      items: [],
    });
  },
);

it.each([
  ["enroll", false],
  ["enroll", true],
  ["remove", false],
  ["remove", true],
  ["clear", false],
  ["clear", true],
] as const)(
  "refuses the original %s request when a fresh owner returns before the real lock grant (synthetic=%s)",
  async (operation, synthetic) => {
    if (synthetic)
      await fixture.enroll("synthetic-pre-grant-password", "synthetic_decoy");
    const syntheticTrap = retiredCredentialStatus("personal").traps.find(
      (trap) => trap.response === "synthetic_decoy",
    );
    const before = kvGet(TRAPS_KEY);
    const generation = assertNotDecoySession();
    const id = retiredCredentialStatus("personal").traps[0]?.id;
    if (!id)
      throw new Error("The genuine enrolled trap must have an identifier.");
    let crossed = false;
    retiredCredentialStorageSeams.locks = () => ({
      async request<T>(
        ...args:
          | [name: string, run: (lock: Lock | null) => T | PromiseLike<T>]
          | [
              name: string,
              options: LockOptions,
              run: (lock: Lock | null) => T | PromiseLike<T>,
            ]
      ): Promise<T> {
        const options = args.length === 3 ? args[1] : {};
        const run = args.length === 3 ? args[2] : args[1];
        if (!crossed) {
          crossed = true;
          fixture.store.lock();
          if (synthetic) {
            if (!syntheticTrap)
              throw new Error("The genuine synthetic trap must be enrolled.");
            await openRetiredCredentialDecoy(
              fixture.store,
              syntheticTrap,
              "personal",
            );
            expect(fixture.store.getSnapshot().decoy).toBe(true);
            fixture.store.lock();
          }
          await fixture.store.unlock(PASSWORD);
          expect(fixture.store.getSnapshot()).toMatchObject({
            status: "unlocked",
            guest: false,
            decoy: false,
          });
          expect(() => assertNotDecoySession(generation)).toThrow();
        }
        return fixture.locks.request(args[0], options, async (lock) =>
          run(lock),
        );
      },
    });
    const operations = {
      enroll: () => fixture.enroll("second-retired-loader-password"),
      remove: () =>
        removeRetiredCredential({
          tomb: "personal",
          currentPassword: PASSWORD,
          id,
        }),
      clear: () =>
        clearRetiredCredentialEvents({
          tomb: "personal",
          currentPassword: PASSWORD,
        }),
    };
    await expect(operations[operation]()).rejects.toThrow("authenticate again");
    expect(crossed).toBe(true);
    expect(kvGet(TRAPS_KEY)).toBe(before);
    expect(fixture.locks.peak()).toBe(1);
  },
);

it.each([
  ["enroll", false],
  ["enroll", true],
  ["remove", false],
  ["remove", true],
  ["clear", false],
  ["clear", true],
] as const)(
  "does not authenticate or mutate after the locked %s loader crosses an owner (synthetic=%s)",
  async (operation, synthetic) => {
    const before = kvGet(TRAPS_KEY);
    const ownerHeader = fixture.store.getSnapshot().header;
    const id = retiredCredentialStatus("personal").traps[0]?.id;
    if (!id)
      throw new Error("The genuine enrolled trap must have an identifier.");
    const refresh = vi.spyOn(retiredCredentialStorageSeams, "refresh");
    let crossed = false;
    // Forward the real test LockManager's grant; interrupt only after the original
    // callback has captured its generation and yielded to the cached import.
    retiredCredentialStorageSeams.locks = () => ({
      async request<T>(
        ...args:
          | [name: string, run: (lock: Lock | null) => T | PromiseLike<T>]
          | [
              name: string,
              options: LockOptions,
              run: (lock: Lock | null) => T | PromiseLike<T>,
            ]
      ): Promise<T> {
        const name = args[0];
        const options = args.length === 3 ? args[1] : {};
        const run = args.length === 3 ? args[2] : args[1];
        return fixture.locks.request(name, options, async (lock) => {
          const pending = Promise.resolve(run(lock));
          if (lock && !crossed) {
            crossed = true;
            retireOwner(synthetic);
          }
          return pending;
        });
      },
    });
    const operations = {
      enroll: () => fixture.enroll("second-retired-loader-password"),
      remove: () =>
        removeRetiredCredential({
          tomb: "personal",
          currentPassword: PASSWORD,
          id,
        }),
      clear: () =>
        clearRetiredCredentialEvents({
          tomb: "personal",
          currentPassword: PASSWORD,
        }),
    };
    await expect(operations[operation]()).rejects.toThrow("authenticate again");
    expect(crossed).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(kvGet(TRAPS_KEY)).toBe(before);
    expect(fixture.locks.peak()).toBe(1);
    expect(fixture.store.getSnapshot().header).toBe(
      synthetic ? null : ownerHeader,
    );
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "locked",
      items: [],
    });
  },
);
