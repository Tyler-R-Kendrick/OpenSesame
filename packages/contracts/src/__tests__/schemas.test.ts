import { describe, expect, it } from "vitest";
import {
  CreateClaimRequestSchema,
  CreateClaimResponseSchema,
  CreateOAuthClientRequestSchema,
  CreateTemporaryProjectRequestSchema,
  PrincipalMeResponseSchema,
  RegisterAgentRequestSchema,
  isAllowedRedirectUri,
} from "../index.js";

describe("contracts schemas", () => {
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
