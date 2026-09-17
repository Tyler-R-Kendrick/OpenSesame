/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeAmbientIfPresent } from "./complete.js";
import { providerConnectionKey } from "./provider.js";
import {
  createMemoryTransactionStore,
  createTransaction,
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

function pending(state: string, issuer: string) {
  const now = Date.now();
  return createTransaction({
    transactionId: "tx-a",
    state,
    nonce: "nonce-value-16chars",
    verifier: "verifier",
    createdAt: now,
    expiresAt: now + 60_000,
    issuer,
    clientId: "spa",
    redirectUri: "https://app.example/",
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/jwks`,
    intent: {
      kind: "ambient",
      policyRevision: "rev1",
      selectedProviderKey: key,
    },
    policyRevision: "rev1",
    generation: 0,
    providerKey: key,
    transport: "silent-redirect",
  });
}

describe("completeAmbientIfPresent", () => {
  beforeEach(() => {
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
    useTransactionStore(createMemoryTransactionStore());
  });

  afterEach(() => {
    resetTransactionStore();
  });

  it("OIDC-MIXUP: provider B callback cannot consume provider A transaction", async () => {
    persistTransaction(pending("state-a", "https://idp.example"));
    persistTransaction(pending("state-b", "https://other.example"));
    await expect(
      completeAmbientIfPresent(
        "?code=abc&state=state-a&iss=https://other.example",
      ),
    ).rejects.toMatchObject({
      code: "mixup",
    });
    expect(lookupTransaction("state-b")?.status).toBe("pending");
    expect(lookupTransaction("state-a")?.status).toBe("cancelled");
  });
});
