import { describe, expect, it } from "vitest";
import * as api from "../index.js";

// The package entry point is a pure re-export barrel; this pins its public
// surface so a dropped export fails loudly instead of silently.
describe("public entry point", () => {
  it("exposes the documented runtime exports", () => {
    expect(api.MemoryPrincipalMappingStore).toBeTypeOf("function");
    expect(api.createProvisionalPrincipal).toBeTypeOf("function");
    expect(api.upgradeProvisionalToUpstream).toBeTypeOf("function");
    expect(api.noEmailAutoLinkPolicy.autoLinkByEmail).toBe(false);
    expect(api.createPasskeySeam).toBeTypeOf("function");
    expect(api.createMemoryChallengeStore).toBeTypeOf("function");
    expect(api.createSimpleWebAuthnVerifyFn).toBeTypeOf("function");
    expect(api.issueAuthenticationChallenge).toBeTypeOf("function");
    expect(api.issueRegistrationChallenge).toBeTypeOf("function");
    expect(api.verifyRegistrationAttestation).toBeTypeOf("function");
    expect(api.UpstreamOidcProviderRegistry).toBeTypeOf("function");
    expect(api.mockUpstreamProvider).toBeTypeOf("function");
    expect(api.createUpstreamAuth).toBeTypeOf("function");
  });
});
