import { describe, expect, it } from "vitest";
import {
  CreateClaimRequestSchema,
  CreateClaimResponseSchema,
  CreateOAuthClientRequestSchema,
  CreateTemporaryProjectRequestSchema,
  PrincipalMeResponseSchema,
  RegisterAgentRequestSchema,
  isAllowedRedirectUri,
  isAllowedSectorIdentifier,
} from "../index.js";

describe("contracts schemas", () => {
  it("refuses a client registration that widens its own flows", () => {
    const base = {
      displayName: "RP",
      redirectUris: ["https://rp.example/cb"],
      sectorIdentifier: "https://rp.example",
    };
    expect(CreateOAuthClientRequestSchema.parse(base).responseTypes).toEqual([
      "code",
    ]);

    // A record that can name `implicit` or `client_credentials` for itself is a
    // token in a URL fragment, or a client acting with no user behind it.
    for (const grantTypes of [
      ["implicit"],
      ["authorization_code", "client_credentials"],
      ["urn:ietf:params:oauth:grant-type:token-exchange"],
    ]) {
      expect(
        CreateOAuthClientRequestSchema.safeParse({ ...base, grantTypes })
          .success,
      ).toBe(false);
    }
    expect(
      CreateOAuthClientRequestSchema.safeParse({
        ...base,
        responseTypes: ["token"],
      }).success,
    ).toBe(false);
    expect(
      CreateOAuthClientRequestSchema.safeParse({
        ...base,
        tokenEndpointAuthMethod: "client_secret_jwt_but_made_up",
      }).success,
    ).toBe(false);
  });

  it("holds a sector identifier to a form a registrant can be held to", () => {
    expect(isAllowedSectorIdentifier("https://rp.example")).toBe(true);
    expect(isAllowedSectorIdentifier("https://rp.example/clients")).toBe(true);
    // A sector decides which pairwise subject a client sees, so a bare label, a
    // plaintext origin, or one dressed in credentials will not do.
    for (const bad of [
      "rp.example",
      "sector-a",
      "http://rp.example",
      "https://rp.example?x=1",
      "https://rp.example#f",
      "https://user@rp.example",
    ]) {
      expect(isAllowedSectorIdentifier(bad), bad).toBe(false);
    }
  });

  it("parses create claim request/response", () => {
    const req = CreateClaimRequestSchema.parse({
      type: "project",
      targetManifest: { id: "prj_1" },
    });
    expect(req.type).toBe("project");

    const res = CreateClaimResponseSchema.parse({
      claimId: "abc",
      claimToken: "osc_clm_abc.secret",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.example.test/claim",
      expiresAt: "2026-08-07T07:00:00.000Z",
      targetManifestDigest: "sha256:deadbeef",
      pollIntervalSeconds: 5,
    });
    expect(res.claimId).toBe("abc");
  });

  it("parses principals/me", () => {
    const me = PrincipalMeResponseSchema.parse({
      id: "prn_1",
      state: "provisional",
      assurance: "provisional",
      createdAt: "2026-08-07T06:00:00.000Z",
      updatedAt: "2026-08-07T06:00:00.000Z",
      version: 1,
    });
    expect(me.identities).toEqual([]);
  });

  it("parses temporary project and agent registration", () => {
    expect(
      CreateTemporaryProjectRequestSchema.parse({ name: "demo" }).name,
    ).toBe("demo");
    expect(
      RegisterAgentRequestSchema.parse({
        displayName: "bot",
        publicKeyJkt: "thumbprint1",
      }).publicKeyJkt,
    ).toBe("thumbprint1");
  });

  it("accepts only safe redirect URI schemes", () => {
    for (const ok of [
      "https://app.example.test/cb",
      "http://127.0.0.1:5173/cb",
      "http://localhost:5173/cb",
      "com.example.app:/oauth",
    ]) {
      expect(isAllowedRedirectUri(ok), ok).toBe(true);
    }
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "http://evil.test/cb",
      "https://app.example.test/cb#frag",
      "https://user:pw@app.example.test/cb",
      "not a url",
    ]) {
      expect(isAllowedRedirectUri(bad), bad).toBe(false);
    }
  });

  it("rejects a javascript: redirect URI on client registration", () => {
    const base = {
      displayName: "app",
      sectorIdentifier: "https://app.example.test",
    };
    expect(() =>
      CreateOAuthClientRequestSchema.parse({
        ...base,
        redirectUris: ["javascript:alert(document.cookie)"],
      }),
    ).toThrow();
    expect(
      CreateOAuthClientRequestSchema.parse({
        ...base,
        redirectUris: ["https://app.example.test/cb"],
      }).redirectUris,
    ).toEqual(["https://app.example.test/cb"]);
  });

  it("rejects invalid claim token shape", () => {
    expect(() =>
      CreateClaimResponseSchema.parse({
        claimId: "abc",
        claimToken: "not-valid",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.test/claim",
        expiresAt: "2026-08-07T07:00:00.000Z",
        targetManifestDigest: "sha256:x",
        pollIntervalSeconds: 5,
      }),
    ).toThrow();
  });
});
