/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
import { type UpstreamIdentity, originClientId } from "../federation.js";
import { admitAmbientSession, vaultStateFromStore } from "./admission.js";
import { fenceLocalSignOut } from "./generation.js";
import { providerConnectionKey } from "./provider.js";

function identity(sub = "sub-1"): UpstreamIdentity {
  return {
    issuer: "https://idp.example",
    upstreamId: "oidc|https://idp.example|spa|",
    idToken: "header.payload.sig",
    pairwiseSub: sub,
    audience: originClientId(),
    jwksUri: "https://idp.example/jwks",
    expiresAt: Date.now() + 60_000,
    email: "user@example.com",
  };
}

const key = providerConnectionKey({
  protocol: "oidc",
  issuer: "https://idp.example",
  clientId: "spa",
});

const intent = {
  kind: "ambient" as const,
  policyRevision: "rev1",
  selectedProviderKey: key,
};

const claims = {
  iss: "https://idp.example",
  sub: "sub-1",
  aud: "spa",
  exp: Math.floor(Date.now() / 1000) + 60,
  iat: Math.floor(Date.now() / 1000),
  nonce: "nonce-value-16chars",
};

describe("ambient admission", () => {
  it("ID-LOCKED: does not unlock or decrypt a locked vault", async () => {
    const saveIdentity = vi.fn();
    const bootstrapEmptyWorkspace = vi.fn();
    const result = await admitAmbientSession(
      {
        intent,
        identity: identity(),
        claims,
        transactionId: "tx1",
        generation: 0,
        policyRevision: "rev1",
        expectedPolicyRevision: "rev1",
        vault: { status: "locked", guest: false },
        permitJitProvisioning: false,
      },
      { saveIdentity, bootstrapEmptyWorkspace },
    );
    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.vaultUnchanged).toBe(true);
      expect(result.createdWorkspace).toBe(false);
    }
    expect(saveIdentity).toHaveBeenCalledTimes(1);
    expect(bootstrapEmptyWorkspace).not.toHaveBeenCalled();
  });

  it("ID-GUEST: open guest workspace is not relabeled", async () => {
    const result = await admitAmbientSession(
      {
        intent,
        identity: identity("sso-sub"),
        claims,
        transactionId: "tx1",
        generation: 0,
        policyRevision: "rev1",
        expectedPolicyRevision: "rev1",
        vault: { status: "unlocked", guest: true, pairwiseSub: "guest-sub" },
        permitJitProvisioning: true,
      },
      { saveIdentity: vi.fn(), bootstrapEmptyWorkspace: vi.fn() },
    );
    expect(result).toEqual({ kind: "rejected", reason: "guest_open" });
  });

  it("ID-HISTORY: never bootstraps workspace when JIT is off", async () => {
    const bootstrapEmptyWorkspace = vi.fn();
    await admitAmbientSession(
      {
        intent,
        identity: identity(),
        claims,
        transactionId: "tx1",
        generation: 0,
        policyRevision: "rev1",
        expectedPolicyRevision: "rev1",
        vault: { status: "empty", guest: false },
        permitJitProvisioning: false,
      },
      { saveIdentity: vi.fn(), bootstrapEmptyWorkspace },
    );
    expect(bootstrapEmptyWorkspace).not.toHaveBeenCalled();
  });

  it("LIFE-LOGOUT: stale generation is refused", async () => {
    fenceLocalSignOut();
    const result = await admitAmbientSession(
      {
        intent,
        identity: identity(),
        claims,
        transactionId: "tx1",
        generation: 0,
        policyRevision: "rev1",
        expectedPolicyRevision: "rev1",
        vault: { status: "empty", guest: false },
        permitJitProvisioning: false,
      },
      { saveIdentity: vi.fn(), bootstrapEmptyWorkspace: vi.fn() },
    );
    expect(result).toEqual({ kind: "rejected", reason: "stale_generation" });
  });

  it("LIFE-LOGOUT: sign-out during save rolls back the written identity", async () => {
    const saveIdentity = vi.fn(() => {
      fenceLocalSignOut();
    });
    const clearIdentity = vi.fn();
    const result = await admitAmbientSession(
      {
        intent,
        identity: identity(),
        claims,
        transactionId: "tx1",
        generation: 0,
        policyRevision: "rev1",
        expectedPolicyRevision: "rev1",
        vault: { status: "empty", guest: false },
        permitJitProvisioning: false,
      },
      { saveIdentity, clearIdentity, bootstrapEmptyWorkspace: vi.fn() },
    );
    expect(result).toEqual({ kind: "rejected", reason: "stale_generation" });
    expect(saveIdentity).toHaveBeenCalledTimes(1);
    expect(clearIdentity).toHaveBeenCalledTimes(1);
  });

  it("ID-COOKIE: unlocked vault without this pairwiseSub is a mismatch", async () => {
    const saveIdentity = vi.fn();
    const result = await admitAmbientSession(
      {
        intent,
        identity: identity("sso-sub"),
        claims: { ...claims, sub: "sso-sub" },
        transactionId: "tx1",
        generation: 0,
        policyRevision: "rev1",
        expectedPolicyRevision: "rev1",
        vault: {
          status: "unlocked",
          guest: false,
          pairwiseSub: "cookie-sub",
        },
        permitJitProvisioning: false,
      },
      { saveIdentity, bootstrapEmptyWorkspace: vi.fn() },
    );
    expect(result).toEqual({ kind: "mismatch" });
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  it("ID-SAMEEMAIL: different subjects are not merged on email", async () => {
    const saveIdentity = vi.fn();
    const result = await admitAmbientSession(
      {
        intent,
        identity: {
          ...identity("issuer-b-sub"),
          issuer: "https://other.example",
          email: "user@example.com",
        },
        claims: {
          ...claims,
          iss: "https://other.example",
          sub: "issuer-b-sub",
        },
        transactionId: "tx1",
        generation: 0,
        policyRevision: "rev1",
        expectedPolicyRevision: "rev1",
        vault: {
          status: "unlocked",
          guest: false,
          pairwiseSub: "sub-1",
        },
        permitJitProvisioning: false,
      },
      { saveIdentity, bootstrapEmptyWorkspace: vi.fn() },
    );
    expect(result).toEqual({ kind: "mismatch" });
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  it("vaultStateFromStore keeps pairwiseSub for mismatch checks", () => {
    expect(
      vaultStateFromStore({
        status: "unlocked",
        guest: false,
        pairwiseSub: "open-sub",
      }),
    ).toEqual({
      status: "unlocked",
      guest: false,
      pairwiseSub: "open-sub",
    });
  });

  it("explicit attach intent cannot enter the ambient path", async () => {
    const result = await admitAmbientSession(
      {
        intent: {
          kind: "attach-account",
          targetPrincipalId: "prn_1",
          interactionRef: "int_1",
        },
        identity: identity(),
        claims,
        transactionId: "tx1",
        generation: 0,
        policyRevision: "rev1",
        expectedPolicyRevision: "rev1",
        vault: { status: "empty", guest: false },
        permitJitProvisioning: true,
      },
      { saveIdentity: vi.fn(), bootstrapEmptyWorkspace: vi.fn() },
    );
    expect(result.kind).toBe("rejected");
  });
});
