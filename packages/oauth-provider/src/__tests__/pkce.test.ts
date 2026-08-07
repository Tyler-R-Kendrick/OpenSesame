import { describe, expect, it } from "vitest";
import { createOpenSesameProvider, isPkceRequired } from "../create-provider.js";

describe("PKCE", () => {
  it("requires PKCE for all clients (S256-only provider)", () => {
    const bundle = createOpenSesameProvider({
      issuer: "http://127.0.0.1:3999",
      clients: [
        {
          client_id: "rp-public",
          token_endpoint_auth_method: "none",
          redirect_uris: ["http://127.0.0.1:4000/cb"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          subject_type: "pairwise",
        },
        {
          client_id: "rp-confidential",
          client_secret: "secret",
          redirect_uris: ["http://127.0.0.1:4001/cb"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          subject_type: "pairwise",
        },
      ],
    });

    expect(isPkceRequired(bundle, {}, { clientAuthMethod: "none" })).toBe(true);
    expect(isPkceRequired(bundle, {}, { clientAuthMethod: "client_secret_basic" })).toBe(
      true,
    );
    expect(bundle.configuration.features).toMatchObject({
      deviceFlow: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
      userinfo: { enabled: true },
      pushedAuthorizationRequests: { enabled: true },
      dPoP: { enabled: true },
      resourceIndicators: { enabled: true },
      registration: { enabled: false },
    });
  });
});
