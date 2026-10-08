/** @vitest-environment jsdom */
/** Actual jsdom Web Storage through production sealed ports; no memory-store substitution.
 * FIFO Web Locks and physical quota refusal are the only adapter doubles.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../../host.js";
import { localStore, sessionStore } from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { providerConnectionKey } from "./provider.js";
import {
  TX_MAX_RECORDS,
  TX_STORE_KEY,
  cancelAllTransactions,
  cancelTransaction,
  claimTransaction,
  consumeTransaction,
  createTransaction,
  inspectLegacyPending,
  legacyPendingUsableForAmbient,
  localTransactionStore,
  lookupTransaction,
  persistTransaction,
  pruneExpired,
  resetTransactionStore,
  withTransactionLock,
} from "./transactions.js";

const originalHost = host();
const legacyKey = "opensesame:federation:pkce";
const providerKey = providerConnectionKey({
  protocol: "oidc",
  issuer: "https://idp.example.test",
  clientId: "spa",
});
function transaction(state: string, createdAt = Date.now()) {
  return createTransaction({
    transactionId: `transaction-${state}`,
    state,
    nonce: "nonce-with-at-least-sixteen-characters",
    verifier: "private-PKCE-verifier",
    createdAt,
    expiresAt: createdAt + 600_000,
    issuer: "https://idp.example.test",
    clientId: "spa",
    redirectUri: "https://app.example.test/callback",
    tokenEndpoint: "https://idp.example.test/token",
    jwksUri: "https://idp.example.test/jwks",
    intent: {
      kind: "ambient",
      policyRevision: "r1",
      selectedProviderKey: providerKey,
    },
    policyRevision: "r1",
    generation: 1,
    providerKey,
    transport: "silent-redirect",
  });
}
beforeEach(() => {
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      storage: { local: window.localStorage, session: window.sessionStorage },
    }),
  );
  resetTransactionStore();
  localStore().removeItem(TX_STORE_KEY);
  localStore().removeItem(legacyKey);
  sessionStore().removeItem(legacyKey);
});
afterEach(() => {
  resetTransactionStore();
  localStore().removeItem(TX_STORE_KEY);
  localStore().removeItem(legacyKey);
  sessionStore().removeItem(legacyKey);
  vi.restoreAllMocks();
  configureHost(originalHost);
});

it("persists sealed correlation and prevents another tab consuming the real claimant's callback", () => {
  const record = transaction("live-callback-state");
  persistTransaction(record);
  const physical = window.localStorage.getItem(TX_STORE_KEY);
  expect(physical).toBeTruthy();
  expect(physical).not.toContain(record.verifier);
  expect(physical).not.toContain(record.nonce);
  resetTransactionStore();
  expect(lookupTransaction(record.state)).toEqual(record);
  expect(claimTransaction("unrelated-callback", "tab-b")).toBeNull();
  expect(claimTransaction(record.state, "tab-a")?.claimOwner).toBe("tab-a");
  const claimedBytes = window.localStorage.getItem(TX_STORE_KEY);
  expect(claimTransaction(record.state, "tab-b")).toBeNull();
  expect(consumeTransaction(record.state, "tab-b")).toBe(false);
  expect(window.localStorage.getItem(TX_STORE_KEY)).toBe(claimedBytes);
  expect(consumeTransaction(record.state, "tab-a")).toBe(true);
  expect(claimTransaction(record.state, "tab-a")).toBeNull();
  expect(consumeTransaction(record.state, "tab-a")).toBe(false);
  expect(localTransactionStore.get(record.state)?.status).toBe("consumed");
});

it("cancels pending and claimed callbacks while retaining consumed evidence, then prunes only expired live records", () => {
  const now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (const state of ["pending", "claimed", "consumed"])
    persistTransaction(transaction(state));
  claimTransaction("claimed", "tab-a");
  claimTransaction("consumed", "tab-a");
  consumeTransaction("consumed", "tab-a");
  cancelAllTransactions();
  expect(lookupTransaction("pending")?.status).toBe("cancelled");
  expect(lookupTransaction("claimed")?.status).toBe("cancelled");
  expect(lookupTransaction("consumed")?.status).toBe("consumed");
  expect(consumeTransaction("claimed", "tab-a")).toBe(false);
  cancelTransaction("consumed");
  cancelTransaction("absent");
  expect(consumeTransaction("absent", "tab-a")).toBe(false);
  expect(lookupTransaction("")).toBeNull();
  expect(claimTransaction("pending", "tab-a")).toBeNull();
  pruneExpired(now + 600_001);
  expect(localTransactionStore.list().map((row) => row.state)).toEqual([
    "consumed",
  ]);
  expect(lookupTransaction("consumed")?.status).toBe("consumed");
  expect(claimTransaction("consumed", "tab-a")).toBeNull();
});

it("expires a late callback without mutating its stored correlation and rejects a caller-supplied later claim time", () => {
  const now = Date.now();
  persistTransaction(transaction("late", now));
  expect(claimTransaction("late", "tab-a", now + 600_001)).toBeNull();
  expect(lookupTransaction("late")?.status).toBe("pending");
  const physical = window.localStorage.getItem(TX_STORE_KEY);
  vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
  expect(lookupTransaction("late")?.status).toBe("expired");
  expect(claimTransaction("late", "tab-a")).toBeNull();
  expect(window.localStorage.getItem(TX_STORE_KEY)).toBe(physical);
});

it("bounds persistent pending callbacks and replaces a duplicate state without growing the record set", () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (let index = 0; index <= TX_MAX_RECORDS; index += 1)
    persistTransaction(transaction(`state-${index}`, now + index));
  expect(localTransactionStore.list()).toHaveLength(TX_MAX_RECORDS);
  expect(lookupTransaction("state-0")).toBeNull();
  expect(lookupTransaction(`state-${TX_MAX_RECORDS}`)?.status).toBe("pending");
  persistTransaction({
    ...transaction(`state-${TX_MAX_RECORDS}`, now + TX_MAX_RECORDS),
    nonce: "replacement-nonce-sixteen-characters",
  });
  expect(localTransactionStore.list()).toHaveLength(TX_MAX_RECORDS);
  expect(lookupTransaction(`state-${TX_MAX_RECORDS}`)?.nonce).toBe(
    "replacement-nonce-sixteen-characters",
  );
  localTransactionStore.delete("state-1");
  expect(lookupTransaction("state-1")).toBeNull();
  expect(localTransactionStore.list()).toHaveLength(TX_MAX_RECORDS - 1);
});

it("refuses malformed persistent callbacks while retaining an independently valid state", () => {
  const valid = transaction("surviving-state");
  const invalid = [
    null,
    { ...valid, state: "old-schema", schemaVersion: 0 },
    { ...valid, state: "missing-intent", intent: null },
    { ...valid, state: "unknown-intent", intent: { kind: "trust-me" } },
    { ...valid, state: "short-nonce", nonce: "short" },
    { ...valid, state: "missing-fields", verifier: undefined },
    { ...valid, state: "non-numeric-generation", generation: "1" },
  ];
  localStore().setItem(TX_STORE_KEY, JSON.stringify([valid, ...invalid]));
  expect(localTransactionStore.list()).toEqual([valid]);
  expect(lookupTransaction("old-schema")).toBeNull();
  expect(claimTransaction("unknown-intent", "tab-a")).toBeNull();
  expect(lookupTransaction(valid.state)).toEqual(valid);
  for (const malformed of ["not-json", "{}", "null"]) {
    localStore().setItem(TX_STORE_KEY, malformed);
    expect(localTransactionStore.list()).toEqual([]);
    expect(claimTransaction(valid.state, "tab-a")).toBeNull();
  }
});

it("a physical quota refusal does not replace an earlier persistent callback", () => {
  persistTransaction(transaction("kept"));
  const physical = window.localStorage.getItem(TX_STORE_KEY);
  const write = vi
    .spyOn(window.Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new DOMException("Quota exhausted", "QuotaExceededError");
    });
  expect(() => persistTransaction(transaction("refused"))).not.toThrow();
  expect(write).toHaveBeenCalledOnce();
  expect(window.localStorage.getItem(TX_STORE_KEY)).toBe(physical);
  expect(lookupTransaction("kept")?.status).toBe("pending");
  expect(lookupTransaction("refused")).toBeNull();
});

it("serializes persistent callback claimers through the actual transaction lock port", async () => {
  persistTransaction(transaction("locked-state"));
  let release: () => void = () => {
    throw new Error("Missing lock release");
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const first = withTransactionLock("opensesame-oidc-callback", async () => {
    order.push("first");
    await gate;
    return claimTransaction("locked-state", "tab-a");
  });
  const second = withTransactionLock("opensesame-oidc-callback", async () => {
    order.push("second");
    return claimTransaction("locked-state", "tab-b");
  });
  await Promise.resolve();
  expect(order).toEqual(["first"]);
  release();
  expect((await first)?.claimOwner).toBe("tab-a");
  expect(await second).toBeNull();
  expect(order).toEqual(["first", "second"]);
});

it("legacy local and tab records remain diagnostic and never acquire ambient authentication intent", () => {
  expect(inspectLegacyPending()).toBeNull();
  sessionStore().setItem(
    legacyKey,
    JSON.stringify({ state: "legacy-tab", createdAt: 7 }),
  );
  expect(inspectLegacyPending()).toEqual({
    state: "legacy-tab",
    createdAt: 7,
    intentMissing: true,
  });
  expect(legacyPendingUsableForAmbient()).toBe(false);
  localStore().setItem(
    legacyKey,
    JSON.stringify({ state: "legacy-local", intent: { kind: "ambient" } }),
  );
  expect(inspectLegacyPending()).toEqual({
    state: "legacy-local",
    createdAt: undefined,
    intentMissing: false,
  });
  expect(legacyPendingUsableForAmbient()).toBe(false);
  for (const malformed of ["{", "null", JSON.stringify({ state: 1 })]) {
    localStore().setItem(legacyKey, malformed);
    expect(inspectLegacyPending()).toBeNull();
  }
});
