import { describe, expect, it, vi } from "vitest";
import { exchangeAmbientCode } from "./oidc.js";
import { providerConnectionKey } from "./provider.js";
import { createTransaction } from "./transactions.js";

const issuer = "https://idp.example";
const key = providerConnectionKey({
  protocol: "oidc",
  issuer,
  clientId: "spa",
});

function transaction(tokenEndpoint: string, jwksUri: string) {
  const now = Date.now();
  return createTransaction({
    transactionId: "tx-a",
    state: "state-a",
    nonce: "nonce-value-16chars",
    verifier: "verifier",
    createdAt: now,
    expiresAt: now + 60_000,
    issuer,
    clientId: "spa",
    redirectUri: "https://app.example/",
    tokenEndpoint,
    jwksUri,
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

describe("exchangeAmbientCode endpoint pin", () => {
  it("does not post the code when the token endpoint is another origin", async () => {
    const fetchImpl = vi.fn();
    await expect(
      exchangeAmbientCode(
        transaction("https://attacker.example/token", `${issuer}/jwks`),
        "code",
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "untrusted_issuer" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not post the code when the JWKS is another origin", async () => {
    const fetchImpl = vi.fn();
    await expect(
      exchangeAmbientCode(
        transaction(`${issuer}/token`, "https://attacker.example/jwks"),
        "code",
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "untrusted_issuer" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
