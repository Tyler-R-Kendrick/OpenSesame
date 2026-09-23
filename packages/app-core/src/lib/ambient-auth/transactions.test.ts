/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAuthCallback } from "../federation-callback.js";
import { providerConnectionKey } from "./provider.js";
import {
  cancelTransaction,
  claimTransaction,
  consumeTransaction,
  createMemoryTransactionStore,
  createTransaction,
  inspectLegacyPending,
  legacyPendingUsableForAmbient,
  lookupTransaction,
  persistTransaction,
  resetTransactionStore,
  useTransactionStore,
} from "./transactions.js";

const key = providerConnectionKey({
  protocol: "oidc",
  issuer: "https://idp.example",
  clientId: "spa",
});

function tx(state: string) {
  const now = Date.now();
  return createTransaction({
    transactionId: "tx1",
    state,
    nonce: "nonce-value-16chars",
    verifier: "verifier",
    createdAt: now,
    expiresAt: now + 60_000,
    issuer: "https://idp.example",
    clientId: "spa",
    redirectUri: "https://app.example/",
    tokenEndpoint: "https://idp.example/token",
    jwksUri: "https://idp.example/jwks",
    intent: {
      kind: "ambient",
      policyRevision: "rev1",
      selectedProviderKey: key,
    },
    policyRevision: "rev1",
    generation: 1,
    providerKey: key,
    transport: "silent-redirect",
  });
}

describe("ambient transactions", () => {
  beforeEach(() => {
    useTransactionStore(createMemoryTransactionStore());
  });
  afterEach(() => {
    resetTransactionStore();
  });

  it("OIDC-STATE: missing/wrong state does not consume another record", () => {
    persistTransaction(tx("live-state"));
    expect(claimTransaction("other", "tab-a")).toBeNull();
    expect(lookupTransaction("live-state")?.status).toBe("pending");
  });

  it("LIFE-CALLBACKRACE: second claimer cannot consume", () => {
    persistTransaction(tx("s1"));
    expect(claimTransaction("s1", "tab-a")?.claimOwner).toBe("tab-a");
    expect(claimTransaction("s1", "tab-b")).toBeNull();
    expect(consumeTransaction("s1", "tab-b")).toBe(false);
    expect(consumeTransaction("s1", "tab-a")).toBe(true);
  });

  it("OIDC-ERROR-STATE: error parser keeps uncorrelated callbacks distinct", () => {
    const parsed = parseAuthCallback("?error=login_required");
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") expect(parsed.state).toBeNull();
  });

  it("OIDC-DUPLICATES: success plus error is refused", () => {
    const parsed = parseAuthCallback("?code=abc&error=login_required&state=s");
    expect(parsed).toEqual({ kind: "malformed", reason: "duplicate_params" });
  });

  it("OIDC-LEGACY: legacy pending cannot be used for ambient", () => {
    expect(legacyPendingUsableForAmbient()).toBe(false);
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    });
    localStorage.setItem(
      "opensesame:federation:pkce",
      JSON.stringify({ state: "old", verifier: "v" }),
    );
    const legacy = inspectLegacyPending();
    expect(legacy?.intentMissing).toBe(true);
    expect(legacy?.createdAt).toBeUndefined();
  });

  it("LIFE-TIMEOUT: cancelled records refuse late consume", () => {
    persistTransaction(tx("late"));
    cancelTransaction("late");
    expect(claimTransaction("late", "tab-a")).toBeNull();
    expect(consumeTransaction("late", "tab-a")).toBe(false);
  });
});
