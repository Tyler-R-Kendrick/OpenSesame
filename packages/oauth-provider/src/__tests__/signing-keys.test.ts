import { describe, expect, it } from "vitest";
import { EnvSigningKeyProvider } from "../keys/dev-signing-key-provider.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

const PRIVATE_FIELDS = ["d", "p", "q", "dp", "dq", "qi"] as const;

const jwks = {
  keys: [
    {
      kty: "RSA",
      kid: "k-sign",
      use: "sig",
      alg: "RS256",
      n: "modulus",
      e: "AQAB",
      d: "private-exponent",
      p: "prime-1",
      q: "prime-2",
      dp: "exp-1",
      dq: "exp-2",
      qi: "coefficient",
    },
  ],
};

describe("EnvSigningKeyProvider", () => {
  it("fails open to an empty dev key set when unset outside production", async () => {
    const provider = new EnvSigningKeyProvider({});
    await expect(provider.getActiveSigningKeys()).resolves.toEqual([]);
    await expect(provider.getJwks()).resolves.toEqual({ keys: [] });
    await expect(provider.rotationStatus()).resolves.toEqual({
      activeKid: "dev-unset",
      retiringKids: [],
    });
  });

  it("fails closed in production when OPENSESAME_JWKS_JSON is missing", async () => {
    const provider = new EnvSigningKeyProvider({ NODE_ENV: "production" });
    await expect(provider.getActiveSigningKeys()).rejects.toThrow(
      /OPENSESAME_JWKS_JSON required in production/,
    );
    await expect(provider.rotationStatus()).rejects.toThrow(
      /required in production/,
    );
  });

  it("fails closed outside production when dev defaults are disallowed", async () => {
    const provider = new EnvSigningKeyProvider({}, false);
    await expect(provider.getActiveSigningKeys()).rejects.toThrow(
      /required in production/,
    );
  });

  it("returns the parsed signing keys and reports the first kid as active", async () => {
    const provider = new EnvSigningKeyProvider({
      OPENSESAME_JWKS_JSON: JSON.stringify(jwks),
    });

    const keys = await provider.getActiveSigningKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.kid).toBe("k-sign");
    // Private material stays on the signing key set.
    expect(keys[0]?.d).toBe("private-exponent");

    await expect(provider.rotationStatus()).resolves.toEqual({
      activeKid: "k-sign",
      retiringKids: [],
    });
  });

  it("strips private fields from the public JWKS", async () => {
    const provider = new EnvSigningKeyProvider({
      OPENSESAME_JWKS_JSON: JSON.stringify(jwks),
    });

    const publicJwks = await provider.getJwks();
    expect(publicJwks.keys).toHaveLength(1);
    const key = overlapCast(publicJwks.keys[0]);
    for (const field of PRIVATE_FIELDS) {
      expect(key, field).not.toHaveProperty(field);
    }
    expect(key.kty).toBe("RSA");
    expect(key.kid).toBe("k-sign");
    expect(key.n).toBe("modulus");

    // The source env document must not be mutated.
    expect(jwks.keys[0].d).toBe("private-exponent");
  });

  it("falls back to kid `k1` when the first key has none", async () => {
    const provider = new EnvSigningKeyProvider({
      OPENSESAME_JWKS_JSON: JSON.stringify({ keys: [{ kty: "RSA" }] }),
    });
    await expect(provider.rotationStatus()).resolves.toEqual({
      activeKid: "k1",
      retiringKids: [],
    });
  });

  it("propagates JSON parse errors for malformed JWKS", async () => {
    const provider = new EnvSigningKeyProvider({
      OPENSESAME_JWKS_JSON: "not json",
    });
    await expect(provider.getActiveSigningKeys()).rejects.toThrow();
  });
});
