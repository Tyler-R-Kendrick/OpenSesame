/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function stubStorage(): void {
  const memory = new Map<string, string>();
  const store = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => {
      memory.clear();
    },
  };
  vi.stubGlobal("localStorage", store);
}

beforeEach(() => {
  stubStorage();
});
import {
  ambientControllerSeams,
  evaluateEligibility,
  resetAmbientController,
  runAutomaticAttempt,
  startAutomaticAttempt,
} from "./controller.js";
import { entraSeams } from "./entra.js";
import { fenceLocalSignOut } from "./generation.js";
import { providerConnectionKey } from "./provider.js";

const entraIssuer =
  "https://login.microsoftonline.com/aaaabbbb-cccc-dddd-eeee-ffffffffffff/v2.0";
const entraKey = providerConnectionKey({
  protocol: "entra",
  issuer: entraIssuer,
  clientId: "spa",
});
const entraIdp = {
  providerId: "microsoft",
  issuer: entraIssuer,
  clientId: "spa",
  label: "Contoso",
};

const runtime = {
  schemaVersion: 1,
  mode: "deployment-selected" as const,
  selectedProviderKey: entraKey,
  allowedTransport: "silent-redirect" as const,
};

describe("ambient controller", () => {
  afterEach(() => {
    resetAmbientController();
    localStorage.clear();
    entraSeams.loadSdk = async () => {
      throw new Error("reset");
    };
  });

  it("POL-DEFAULT: eligible is false so runAutomaticAttempt does not navigate", async () => {
    const navigate = vi.fn();
    ambientControllerSeams.navigate = navigate;
    const eligibility = evaluateEligibility({
      hasAuthCallback: false,
      pathname: "/",
      vaultStatus: "empty",
      guestOpen: false,
      privilegedOperation: false,
      unsavedWork: false,
      localConsentRoute: false,
      existingVerifiedSession: false,
      operatorProviders: [],
    });
    expect(eligibility.state).toBe("ineligible");
    await expect(
      runAutomaticAttempt(eligibility, "https://app.example/"),
    ).resolves.toEqual({
      kind: "cancelled",
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("POL-LOCAL: self-issued consent route is ineligible", () => {
    const eligibility = evaluateEligibility({
      hasAuthCallback: false,
      pathname: "/identity/authorize",
      vaultStatus: "empty",
      guestOpen: false,
      privilegedOperation: false,
      unsavedWork: false,
      localConsentRoute: true,
      existingVerifiedSession: false,
      operatorProviders: [entraIdp],
      runtimePolicy: runtime,
    });
    expect(eligibility.state).toBe("ineligible");
    expect(eligibility.reason).toBe("local_flow");
  });

  it("LIFE-LOCK: suppression after sign-out blocks automatic acquisition", () => {
    fenceLocalSignOut();
    const eligibility = evaluateEligibility({
      hasAuthCallback: false,
      pathname: "/",
      vaultStatus: "locked",
      guestOpen: false,
      privilegedOperation: false,
      unsavedWork: false,
      localConsentRoute: false,
      existingVerifiedSession: false,
      operatorProviders: [entraIdp],
      runtimePolicy: runtime,
    });
    expect(eligibility.reason).toBe("suppressed");
  });

  it("callback classification wins over auto eligibility", () => {
    const eligibility = evaluateEligibility({
      hasAuthCallback: true,
      pathname: "/",
      vaultStatus: "empty",
      guestOpen: false,
      privilegedOperation: false,
      unsavedWork: false,
      localConsentRoute: false,
      existingVerifiedSession: false,
      operatorProviders: [entraIdp],
      runtimePolicy: runtime,
    });
    expect(eligibility.state).toBe("ineligible");
  });

  it("POL-ENTERPRISE: one eligible attempt records the budget", async () => {
    const navigate = vi.fn();
    ambientControllerSeams.navigate = navigate;
    ambientControllerSeams.discover = async () => ({
      authorization_endpoint: `${entraIssuer}/authorize`,
      token_endpoint: `${entraIssuer}/token`,
      jwks_uri: `${entraIssuer}/discovery/v2.0/keys`,
    });
    const eligibility = evaluateEligibility({
      hasAuthCallback: false,
      pathname: "/",
      vaultStatus: "empty",
      guestOpen: false,
      privilegedOperation: false,
      unsavedWork: false,
      localConsentRoute: false,
      existingVerifiedSession: false,
      operatorProviders: [entraIdp],
      runtimePolicy: runtime,
    });
    expect(eligibility.state).toBe("eligible");
    await runAutomaticAttempt(eligibility, "https://app.example/");
    expect(navigate).toHaveBeenCalledTimes(1);
    const url = new URL(String(navigate.mock.calls[0]?.[0]));
    expect(url.searchParams.get("prompt")).toBe("none");
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("scope")).not.toMatch(/graph|offline_access/i);
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("PROVIDER-SHOO: Shoo automatic acquisition does not navigate", async () => {
    const shooKey = providerConnectionKey({
      protocol: "shoo",
      issuer: "https://shoo.dev",
      clientId: "origin:https://app.example",
    });
    const navigate = vi.fn();
    ambientControllerSeams.navigate = navigate;
    const eligibility = evaluateEligibility({
      hasAuthCallback: false,
      pathname: "/",
      vaultStatus: "empty",
      guestOpen: false,
      privilegedOperation: false,
      unsavedWork: false,
      localConsentRoute: false,
      existingVerifiedSession: false,
      operatorProviders: [
        {
          providerId: "shoo",
          issuer: "https://shoo.dev",
          clientId: "origin:https://app.example",
          label: "Google",
        },
      ],
      runtimePolicy: {
        schemaVersion: 1,
        mode: "deployment-selected",
        selectedProviderKey: shooKey,
        allowedTransport: "silent-redirect",
      },
    });
    expect(
      eligibility.decision.eligible === false ||
        eligibility.connection?.protocol === "shoo",
    ).toBe(true);
    const outcome = await runAutomaticAttempt(
      { ...eligibility, state: "eligible", connection: eligibility.connection },
      "https://app.example/",
    );
    if (eligibility.connection?.protocol === "shoo") {
      expect(outcome.kind).toBe("unsupported");
    }
    expect(navigate).not.toHaveBeenCalled();
  });

  it("silent-iframe calls acquireEntraSilent and never top-level redirects", async () => {
    const navigate = vi.fn();
    const discover = vi.fn();
    const ssoSilent = vi.fn(
      async (_request: { prompt?: string; scopes?: string[] }) => {
        throw new Error("interaction_required");
      },
    );
    ambientControllerSeams.navigate = navigate;
    ambientControllerSeams.discover = discover;
    entraSeams.loadSdk = async () => ({
      getAllAccounts: () => [],
      ssoSilent,
      loginRedirect: async () => undefined,
      clearCache: async () => undefined,
    });
    const eligibility = evaluateEligibility({
      hasAuthCallback: false,
      pathname: "/",
      vaultStatus: "empty",
      guestOpen: false,
      privilegedOperation: false,
      unsavedWork: false,
      localConsentRoute: false,
      existingVerifiedSession: false,
      operatorProviders: [entraIdp],
      runtimePolicy: {
        ...runtime,
        allowedTransport: "silent-iframe",
      },
    });
    expect(eligibility.state).toBe("eligible");
    const outcome = await runAutomaticAttempt(
      eligibility,
      "https://app.example/auth/redirect.html",
    );
    expect(outcome.kind).toBe("interaction-required");
    expect(ssoSilent).toHaveBeenCalledTimes(1);
    expect(ssoSilent.mock.calls[0]?.[0]?.prompt).toBe("none");
    expect(ssoSilent.mock.calls[0]?.[0]?.scopes).toEqual(["openid"]);
    expect(navigate).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it("LIFE-TWOTABS: second automatic attempt is fenced by the budget", async () => {
    const navigate = vi.fn();
    ambientControllerSeams.navigate = navigate;
    ambientControllerSeams.discover = async () => ({
      authorization_endpoint: `${entraIssuer}/authorize`,
      token_endpoint: `${entraIssuer}/token`,
      jwks_uri: `${entraIssuer}/discovery/v2.0/keys`,
    });
    const eligibility = evaluateEligibility({
      hasAuthCallback: false,
      pathname: "/",
      vaultStatus: "empty",
      guestOpen: false,
      privilegedOperation: false,
      unsavedWork: false,
      localConsentRoute: false,
      existingVerifiedSession: false,
      operatorProviders: [entraIdp],
      runtimePolicy: runtime,
    });
    await runAutomaticAttempt(eligibility, "https://app.example/");
    await runAutomaticAttempt(eligibility, "https://app.example/");
    expect(navigate).toHaveBeenCalledTimes(1);
    const concurrent = await Promise.all([
      startAutomaticAttempt(eligibility, "https://app.example/"),
      startAutomaticAttempt(eligibility, "https://app.example/"),
    ]);
    expect(concurrent[0]).toEqual(concurrent[1]);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("LIFE-SWITCH: sign-out during silent acquisition fences the result", async () => {
    const navigate = vi.fn();
    ambientControllerSeams.navigate = navigate;
    entraSeams.loadSdk = async () => ({
      getAllAccounts: () => [],
      ssoSilent: async () => {
        fenceLocalSignOut();
        return { idToken: "stale-id-token" };
      },
      loginRedirect: async () => undefined,
      clearCache: async () => undefined,
    });
    const eligibility = evaluateEligibility({
      hasAuthCallback: false,
      pathname: "/",
      vaultStatus: "empty",
      guestOpen: false,
      privilegedOperation: false,
      unsavedWork: false,
      localConsentRoute: false,
      existingVerifiedSession: false,
      operatorProviders: [entraIdp],
      runtimePolicy: {
        ...runtime,
        allowedTransport: "silent-iframe",
      },
    });
    const outcome = await runAutomaticAttempt(
      eligibility,
      "https://app.example/auth/redirect.html",
    );
    expect(outcome).toEqual({ kind: "rejected", reason: "stale_generation" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
