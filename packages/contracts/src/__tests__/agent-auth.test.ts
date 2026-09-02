import { describe, expect, it } from "vitest";
import {
  AGENT_CLAIM_GRANT,
  AgentClaimInitRequestSchema,
  AgentIdentityRequestSchema,
  JWT_BEARER_GRANT,
  SERVICE_ASSERTION_TYP,
} from "../agent-auth.js";

describe("agent-auth wire schemas", () => {
  it("accepts anonymous, service_auth, and identity_assertion discriminators", () => {
    expect(AgentIdentityRequestSchema.parse({ type: "anonymous" })).toEqual({
      type: "anonymous",
    });
    expect(
      AgentIdentityRequestSchema.parse({
        type: "service_auth",
        login_hint: "user@example.com",
      }).type,
    ).toBe("service_auth");
    expect(
      AgentIdentityRequestSchema.parse({
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: "eyJhbGc.e30.sig",
      }).type,
    ).toBe("identity_assertion");
  });

  it("rejects a missing discriminator", () => {
    expect(() =>
      AgentIdentityRequestSchema.parse({ login_hint: "x" }),
    ).toThrow();
  });

  it("rejects an empty login_hint and an empty identity assertion", () => {
    expect(() =>
      AgentIdentityRequestSchema.parse({
        type: "service_auth",
        login_hint: "",
      }),
    ).toThrow();
    expect(() =>
      AgentIdentityRequestSchema.parse({
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: "",
      }),
    ).toThrow();
  });

  it("requires a claim_token to start a ceremony", () => {
    expect(() => AgentClaimInitRequestSchema.parse({})).toThrow();
    expect(
      AgentClaimInitRequestSchema.parse({
        claim_token: "clm_abc.secret",
        email: "user@example.com",
      }).email,
    ).toBe("user@example.com");
  });

  it("keeps grant URNs and service assertion typ distinct from ID-JAG", () => {
    expect(JWT_BEARER_GRANT).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    expect(AGENT_CLAIM_GRANT).toBe("urn:workos:agent-auth:grant-type:claim");
    expect(SERVICE_ASSERTION_TYP).toBe("os-sia+jwt");
    expect(SERVICE_ASSERTION_TYP).not.toBe("oauth-id-jag+jwt");
  });
});
