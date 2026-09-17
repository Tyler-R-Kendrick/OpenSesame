/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuthOutcome } from "../auth-outcome.js";
import {
  type UpstreamIdentity,
  loadSession,
  originClientId,
  saveSession,
} from "../federation.js";
import {
  type VaultNamespaceState,
  ambientAdmissionSeams,
} from "./admission.js";
import { clearAutoAuthSuppression, fenceLocalSignOut } from "./generation.js";
import { providerConnectionKey } from "./provider.js";
import { ambientReturnSeams, applyAmbientReturn } from "./return-path.js";

function stubStorage(): void {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => memory.clear(),
  });
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => {
      session.set(key, value);
    },
    removeItem: (key: string) => {
      session.delete(key);
    },
    clear: () => session.clear(),
  });
}

const originalVault = ambientReturnSeams.vault;
const originalSave = ambientAdmissionSeams.saveIdentity;

const key = providerConnectionKey({
  protocol: "oidc",
  issuer: "https://shoo.dev",
  clientId: "spa",
});

function identity(sub: string, issuer = "https://shoo.dev"): UpstreamIdentity {
  return {
    issuer,
    upstreamId: key,
    idToken: "token",
    pairwiseSub: sub,
    audience: originClientId(),
    jwksUri: `${issuer}/jwks`,
    expiresAt: Date.now() + 60_000,
    email: "user@example.com",
    name: "Pat",
  };
}

function completed(sub = "sso-sub", issuer = "https://shoo.dev") {
  const id = identity(sub, issuer);
  return {
    identity: id,
    intent: {
      kind: "ambient" as const,
      policyRevision: "rev1",
      selectedProviderKey: key,
    },
    transactionId: "tx1",
    generation: 0,
    policyRevision: "rev1",
    claims: {
      iss: issuer,
      sub,
      aud: "spa",
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
    },
  };
}

function setVault(vault: VaultNamespaceState): void {
  ambientReturnSeams.vault = () => vault;
}

describe("applyAmbientReturn", () => {
  beforeEach(() => {
    stubStorage();
    ambientAdmissionSeams.saveIdentity = originalSave;
  });

  afterEach(() => {
    ambientReturnSeams.vault = originalVault;
    ambientAdmissionSeams.saveIdentity = originalSave;
  });

  it("ID-COOKIE: external subject is saved; cookie principal is not linked", async () => {
    saveSession(identity("cookie-sub"));
    setVault({ status: "empty", guest: false });
    await applyAmbientReturn(completed("sso-sub"));
    expect(loadSession()?.pairwiseSub).toBe("sso-sub");
    expect(loadSession()?.pairwiseSub).not.toBe("cookie-sub");
    expect(readAuthOutcome()?.kind).toBe("authenticated");
  });

  it("ID-SAMEEMAIL: different issuer/subject is not merged onto the open vault", async () => {
    saveSession({
      ...identity("open-sub", "https://shoo.dev"),
      email: "user@example.com",
    });
    setVault({
      status: "unlocked",
      guest: false,
      pairwiseSub: "open-sub",
    });
    const saveIdentity = vi.fn();
    ambientAdmissionSeams.saveIdentity = saveIdentity;
    await applyAmbientReturn(completed("other-sub", "https://other.example"));
    expect(saveIdentity).not.toHaveBeenCalled();
    expect(readAuthOutcome()?.kind).toBe("error");
    expect(readAuthOutcome()?.kind).not.toBe("authenticated");
  });

  it("guest_open does not store an authenticated outcome", async () => {
    setVault({ status: "unlocked", guest: true, pairwiseSub: "guest-sub" });
    const saveIdentity = vi.fn();
    ambientAdmissionSeams.saveIdentity = saveIdentity;
    await applyAmbientReturn(completed("sso-sub"));
    expect(saveIdentity).not.toHaveBeenCalled();
    expect(readAuthOutcome()?.kind).toBe("error");
  });

  it("stale generation after sign-out is not authenticated", async () => {
    setVault({ status: "empty", guest: false });
    fenceLocalSignOut();
    const saveIdentity = vi.fn();
    ambientAdmissionSeams.saveIdentity = saveIdentity;
    await applyAmbientReturn(completed("sso-sub"));
    expect(saveIdentity).not.toHaveBeenCalled();
    expect(readAuthOutcome()?.kind).not.toBe("authenticated");
  });

  it("LIFE-LOGOUT: sign-out during save leaves no loadable session after suppression lifts", async () => {
    setVault({ status: "empty", guest: false });
    ambientAdmissionSeams.saveIdentity = (id) => {
      fenceLocalSignOut();
      saveSession(id);
    };
    await applyAmbientReturn(completed("sso-sub"));
    expect(readAuthOutcome()?.kind).not.toBe("authenticated");
    clearAutoAuthSuppression();
    expect(loadSession()).toBeNull();
  });
});
