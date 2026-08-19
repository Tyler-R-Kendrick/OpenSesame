import { describe, expect, it } from "vitest";
import {
  canonicalResource,
  createOpenSesameProvider,
  isResourceAllowed,
} from "../create-provider.js";

const ISSUER = "https://id.example.test";

describe("canonicalResource", () => {
  it("normalizes scheme, host and trailing slash", () => {
    expect(canonicalResource("HTTPS://API.Example.test/v1/")).toBe(
      "https://api.example.test/v1",
    );
  });

  it("rejects fragments, queries and non-http schemes", () => {
    expect(canonicalResource("https://api.example.test/v1#f")).toBeNull();
    expect(canonicalResource("https://api.example.test/v1?a=1")).toBeNull();
    expect(canonicalResource("urn:example:api")).toBeNull();
    expect(canonicalResource("/relative")).toBeNull();
    expect(canonicalResource("not a url")).toBeNull();
  });
});

describe("isResourceAllowed", () => {
  it("falls back to the issuer when no allowlist is configured", () => {
    expect(isResourceAllowed(ISSUER, [], ISSUER)).toBe(true);
    expect(isResourceAllowed("https://api.github.test", [], ISSUER)).toBe(
      false,
    );
  });

  it("accepts only configured resource servers", () => {
    const allowed = [
      "https://api.example.test",
      "https://files.example.test/v2",
    ];
    expect(
      isResourceAllowed("https://api.example.test/", allowed, ISSUER),
    ).toBe(true);
    expect(
      isResourceAllowed("https://files.example.test/v2", allowed, ISSUER),
    ).toBe(true);
    // Configuring one resource must not admit the issuer implicitly.
    expect(isResourceAllowed(ISSUER, allowed, ISSUER)).toBe(false);
    // Nor a look-alike host or a deeper path.
    expect(
      isResourceAllowed("https://api.example.test.evil.test", allowed, ISSUER),
    ).toBe(false);
    expect(
      isResourceAllowed("https://files.example.test/v2/admin", allowed, ISSUER),
    ).toBe(false);
  });
});

describe("createOpenSesameProvider fail-closed config", () => {
  it("refuses ephemeral signing keys in production", () => {
    expect(() =>
      createOpenSesameProvider({
        issuer: ISSUER,
        env: { isProduction: true },
        processEnv: {},
      }),
    ).toThrow(/signing keys are required in production/);
  });

  it("refuses the memory adapter in production", () => {
    expect(() =>
      createOpenSesameProvider({
        issuer: ISSUER,
        env: { isProduction: true },
        processEnv: {},
        jwks: { keys: [{ kty: "RSA" }] },
      }),
    ).toThrow(/persistent adapter is required in production/);
  });

  it("refuses the in-memory pairwise store in production", () => {
    const adapter = () => {
      throw new Error("adapter unused");
    };
    expect(() =>
      createOpenSesameProvider({
        issuer: ISSUER,
        env: { isProduction: true },
        processEnv: {},
        jwks: { keys: [{ kty: "RSA" }] },
        adapter: adapter as never,
      }),
    ).toThrow(/persistent pairwise subject store is required in production/);
  });

  it("rejects a malformed OPENSESAME_JWKS_JSON", () => {
    expect(() =>
      createOpenSesameProvider({
        issuer: ISSUER,
        processEnv: { OPENSESAME_JWKS_JSON: "{}" },
      }),
    ).toThrow(/non-empty `keys` array/);
  });

  it("still builds a dev provider without keys or adapter", () => {
    const bundle = createOpenSesameProvider({ issuer: ISSUER, processEnv: {} });
    expect(bundle.env.issuer).toBe(ISSUER);
    expect(bundle.configuration.jwks?.keys.length).toBe(1);
  });
});
