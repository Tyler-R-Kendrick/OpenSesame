import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type OpenSesameProviderBundle,
  createOpenSesameProvider,
  isPkceRequired,
  isResourceAllowed,
} from "../create-provider.js";
import { type JsonObject, overlapCast, type BoundaryValue } from "@opensesame/os-domain";

const ISSUER = "https://id.example.test";
const API = "https://api.example.test";

type ResourceIndicatorsConfig = {
  defaultResource: () => Promise<BoundaryValue>;
  getResourceServerInfo: (
    ctx: BoundaryValue,
    resourceIndicator: string,
    client: BoundaryValue,
  ) => Promise<{ scope: string; audience: string; accessTokenFormat: string }>;
  useGrantedResource: () => Promise<boolean>;
};

function resourceIndicators(
  bundle: OpenSesameProviderBundle,
): ResourceIndicatorsConfig {
  return overlapCast(bundle.configuration.features
    ?.resourceIndicators);
}

describe("provider resource indicator callbacks", () => {
  it("serves resource server info only for allowlisted resources", async () => {
    const bundle = createOpenSesameProvider({
      issuer: ISSUER,
      processEnv: {},
      env: { allowedResources: [API] },
    });
    const ri = resourceIndicators(bundle);

    const info = await ri.getResourceServerInfo({}, API, {});
    expect(info).toEqual({
      scope: "openid",
      audience: API,
      accessTokenFormat: "jwt",
    });

    await expect(
      ri.getResourceServerInfo({}, "https://evil.example.test", {}),
    ).rejects.toMatchObject({
      error: "invalid_target",
      error_description: "resource indicator is not an allowed resource server",
    });

    // With no allowlist the issuer itself is the only valid audience.
    const fallback = createOpenSesameProvider({
      issuer: ISSUER,
      processEnv: {},
    });
    const infoFallback = await resourceIndicators(
      fallback,
    ).getResourceServerInfo({}, ISSUER, {});
    expect(infoFallback.audience).toBe(ISSUER);
    await expect(
      resourceIndicators(fallback).getResourceServerInfo({}, API, {}),
    ).rejects.toMatchObject({ error: "invalid_target" });
  });

  it("has no default resource and never reuses granted resources", async () => {
    const bundle = createOpenSesameProvider({ issuer: ISSUER, processEnv: {} });
    const ri = resourceIndicators(bundle);
    await expect(ri.defaultResource()).resolves.toBeUndefined();
    await expect(ri.useGrantedResource()).resolves.toBe(false);
  });
});

describe("provider account and pkce callbacks", () => {
  it("findAccount exposes only the pairwise sub claim", async () => {
    const bundle = createOpenSesameProvider({ issuer: ISSUER, processEnv: {} });
    const findAccount = bundle.configuration.findAccount;
    expect(findAccount).toBeDefined();
    const account = overlapCast(await findAccount?.({}, "user-1"));
    expect(account.accountId).toBe("user-1");
    await expect(account.claims()).resolves.toEqual({ sub: "user-1" });
  });

  it("always requires PKCE under the built configuration", () => {
    const bundle = createOpenSesameProvider({ issuer: ISSUER, processEnv: {} });
    expect(isPkceRequired(bundle)).toBe(true);
  });

  it("reports PKCE as not required when the configuration lacks the hook", () => {
    const fake = overlapCast({
      configuration: {},
    });
    expect(isPkceRequired(fake)).toBe(false);
  });
});

describe("signing key resolution from env", () => {
  it("rejects non-JSON OPENSESAME_JWKS_JSON", () => {
    expect(() =>
      createOpenSesameProvider({
        issuer: ISSUER,
        processEnv: { OPENSESAME_JWKS_JSON: "not json" },
      }),
    ).toThrow(/not valid JSON/);
  });

  it("uses keys from OPENSESAME_JWKS_JSON when present", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = overlapCast(privateKey.export({ format: "jwk" }));
    jwk.kid = "env-key";
    const bundle = createOpenSesameProvider({
      issuer: ISSUER,
      processEnv: { OPENSESAME_JWKS_JSON: JSON.stringify({ keys: [jwk] }) },
    });
    expect(bundle.configuration.jwks?.keys).toEqual([
      expect.objectContaining({ kid: "env-key", kty: "RSA" }),
    ]);
  });
});

describe("isResourceAllowed edge cases", () => {
  it("rejects resource indicators that cannot be canonicalized", () => {
    expect(isResourceAllowed("not a url", [API], ISSUER)).toBe(false);
    expect(
      isResourceAllowed("https://api.example.test/#frag", [API], ISSUER),
    ).toBe(false);
  });

  it("ignores allowlist entries that are not valid resources", () => {
    expect(isResourceAllowed(API, ["not a url", API], ISSUER)).toBe(true);
    expect(isResourceAllowed(ISSUER, ["not a url"], ISSUER)).toBe(false);
  });
});
