/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { markDecoySession } from "../decoy-session.js";
import {
  ENTRA_SCOPES,
  acquireEntraSilent,
  entraJwksUri,
  entraSeams,
  newEntraNonce,
} from "./entra.js";
import { currentAuthGeneration } from "./generation.js";
import { providerConnectionKey } from "./provider.js";

const issuer =
  "https://login.microsoftonline.com/aaaabbbb-cccc-dddd-eeee-ffffffffffff/v2.0";
const connection = {
  key: providerConnectionKey({
    protocol: "entra" as const,
    issuer,
    clientId: "spa",
  }),
  protocol: "entra" as const,
  issuer,
  clientId: "spa",
  displayName: "Contoso",
  capabilities: ["silent-iframe", "interactive-oidc"] as const,
};

describe("entra adapter", () => {
  afterEach(() => {
    markDecoySession(false);
    entraSeams.loadSdk = async () => {
      throw new Error("reset");
    };
  });

  it("does not inspect SDK accounts or acquire ambient tokens after the load crosses a realm reset", async () => {
    const accounts = vi.fn(() => []);
    const silent = vi.fn(async () => ({ idToken: "owner-only-token" }));
    entraSeams.loadSdk = async () => {
      markDecoySession(true);
      markDecoySession(false);
      return {
        getAllAccounts: accounts,
        ssoSilent: silent,
        clearCache: async () => undefined,
      };
    };
    await expect(
      acquireEntraSilent(
        {
          connection,
          redirectUri: "https://app.example/auth/redirect.html",
          generation: currentAuthGeneration(),
          nonce: "current-nonce",
        },
        fetch,
      ),
    ).rejects.toThrow(/authenticate again/);
    expect(accounts).not.toHaveBeenCalled();
    expect(silent).not.toHaveBeenCalled();
  });

  it("PROVIDER-SCOPES: requests openid only, never Graph", () => {
    expect([...ENTRA_SCOPES]).toEqual(["openid"]);
    expect(ENTRA_SCOPES.join(" ")).not.toMatch(
      /User.Read|offline_access|mail|calendar/i,
    );
  });

  it("JWKS URI is tenant discovery, not issuer/discovery/v2.0/keys", () => {
    expect(entraJwksUri(issuer)).toBe(
      "https://login.microsoftonline.com/aaaabbbb-cccc-dddd-eeee-ffffffffffff/discovery/v2.0/keys",
    );
    expect(entraJwksUri(issuer)).not.toContain("/v2.0/discovery/v2.0/");
  });

  it("does not authenticate from getAllAccounts()[0]", async () => {
    const ssoSilent = vi.fn(async () => {
      throw new Error("interaction_required");
    });
    entraSeams.loadSdk = async () => ({
      getAllAccounts: () => [
        { homeAccountId: "a.b", username: "a@contoso.test" },
        { homeAccountId: "c.d", username: "b@contoso.test" },
      ],
      ssoSilent,
      clearCache: async () => undefined,
    });
    const result = await acquireEntraSilent(
      {
        connection,
        redirectUri: "https://app.example/auth/redirect.html",
        generation: 0,
        nonce: newEntraNonce(),
      },
      fetch,
    );
    expect(result.kind).toBe("interaction-required");
    expect(ssoSilent).not.toHaveBeenCalled();
  });

  it("a cache event / ssoSilent result still requires generation match", async () => {
    entraSeams.loadSdk = async () => ({
      getAllAccounts: () => [],
      ssoSilent: async () => ({ idToken: "not-a-verified-token" }),
      clearCache: async () => undefined,
    });
    const result = await acquireEntraSilent(
      {
        connection,
        redirectUri: "https://app.example/auth/redirect.html",
        generation: 99,
        nonce: "nonce-value-16chars-xxxx",
      },
      fetch,
    );
    expect(result.kind).toBe("rejected");
  });
});
