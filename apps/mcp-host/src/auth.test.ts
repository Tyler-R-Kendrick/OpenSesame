import { describe, expect, it } from "vitest";
import {
  MCP_BEARER_PROFILE,
  assertBearerScheme,
  parseBearerAuthorization,
} from "./auth/bearer.js";
import {
  PROTECTED_RESOURCE_WELL_KNOWN,
  summarizeProtectedResource,
} from "./auth/protected-resource.js";

describe("parseBearerAuthorization", () => {
  it("parses a well-formed Bearer header", () => {
    expect(parseBearerAuthorization("Bearer abc.def")).toEqual({
      scheme: "Bearer",
      token: "abc.def",
    });
  });

  it("trims surrounding whitespace on scheme and token", () => {
    expect(parseBearerAuthorization("Bearer   tok  ")).toEqual({
      scheme: "Bearer",
      token: "tok",
    });
  });

  it("returns null when there is no header at all", () => {
    expect(parseBearerAuthorization(undefined)).toBeNull();
    expect(parseBearerAuthorization("")).toBeNull();
  });

  it("returns null when scheme and token are not separated", () => {
    expect(parseBearerAuthorization("Bearer")).toBeNull();
  });

  it("returns null when the header starts with the separator", () => {
    expect(parseBearerAuthorization(" abc")).toBeNull();
  });

  it("returns null when the token part is empty", () => {
    expect(parseBearerAuthorization("Bearer   ")).toBeNull();
  });

  it("keeps everything after the first space as the token", () => {
    expect(parseBearerAuthorization("Basic dXNlcjpw")).toEqual({
      scheme: "Basic",
      token: "dXNlcjpw",
    });
  });
});

describe("assertBearerScheme", () => {
  it("accepts bearer in any case", () => {
    for (const scheme of ["bearer", "Bearer", "BEARER"]) {
      expect(() => assertBearerScheme(scheme)).not.toThrow();
    }
  });

  it("rejects any other scheme", () => {
    expect(() => assertBearerScheme("basic")).toThrow("bearer_scheme_required");
    expect(() => assertBearerScheme("dpop")).toThrow("bearer_scheme_required");
  });
});

describe("summarizeProtectedResource", () => {
  it("always reports Bearer acceptance and never invents a resource", () => {
    expect(MCP_BEARER_PROFILE).toBe("mcp-authorization-2026-07-28-bearer");
    expect(PROTECTED_RESOURCE_WELL_KNOWN).toBe(
      "/.well-known/oauth-protected-resource",
    );

    const notes = summarizeProtectedResource({
      resource: "https://host.example.test",
      authorization_servers: ["https://id.example.test"],
    });
    expect(notes).toEqual({
      profile: "oauth-bearer-rfc6750-v1",
      resource: "https://host.example.test",
      bearerAccepted: true,
      dpopAdvertised: false,
    });
  });

  it("advertises DPoP only when the gateway lists signing algorithms", () => {
    expect(
      summarizeProtectedResource({
        resource: "r",
        dpop_signing_alg_values_supported: ["ES256"],
      }).dpopAdvertised,
    ).toBe(true);
    expect(summarizeProtectedResource({ resource: "r" }).dpopAdvertised).toBe(
      false,
    );
  });

  it("tolerates a missing resource and a non-array authorization_servers", () => {
    const notes = summarizeProtectedResource({
      authorization_servers: "not-an-array",
    });
    expect(notes.resource).toBe("");
    expect(notes.bearerAccepted).toBe(true);
  });
});
