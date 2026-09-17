/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENTRA_SCOPES,
  acquireEntraSilent,
  entraSeams,
  newEntraNonce,
} from "./entra.js";
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
    entraSeams.loadSdk = async () => {
      throw new Error("reset");
    };
  });

  it("PROVIDER-SCOPES: requests openid only, never Graph", () => {
    expect([...ENTRA_SCOPES]).toEqual(["openid"]);
    expect(ENTRA_SCOPES.join(" ")).not.toMatch(
      /User.Read|offline_access|mail|calendar/i,
    );
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
      loginRedirect: async () => undefined,
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
      loginRedirect: async () => undefined,
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
