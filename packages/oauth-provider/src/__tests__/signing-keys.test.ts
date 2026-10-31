import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { EnvSigningKeyProvider } from "../keys/dev-signing-key-provider.js";

const PRIVATE_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

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
      oth: [{ r: "another-prime", d: "another-exponent", t: "another-factor" }],
      privateExtension: { signingSecret: "not-public" },
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

  it("honours the deployment's OPENSESAME_ENV production marker too", async () => {
    const provider = new EnvSigningKeyProvider({
      OPENSESAME_ENV: "production",
    });
    await expect(provider.getActiveSigningKeys()).rejects.toThrow(
      /OPENSESAME_JWKS_JSON required in production/,
    );
    await expect(provider.getJwks()).rejects.toThrow(/required in production/);
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
    expect(key).not.toHaveProperty("privateExtension");
    expect(key.kty).toBe("RSA");
    expect(key.kid).toBe("k-sign");
    expect(key.n).toBe("modulus");

    // The source env document must not be mutated.
    expect(jwks.keys[0].d).toBe("private-exponent");
  });

  it("never publishes symmetric keys or unknown key types", async () => {
    const provider = new EnvSigningKeyProvider({
      OPENSESAME_JWKS_JSON: JSON.stringify({
        keys: [
          { kty: "oct", kid: "symmetric", alg: "HS256", k: "signing-secret" },
          { kty: "future-private-type", secret: "future-signing-secret" },
          ...jwks.keys,
        ],
      }),
    });
    const signingKeys = await provider.getActiveSigningKeys();
    expect(signingKeys).toHaveLength(3);
    expect(signingKeys[0]?.k).toBe("signing-secret");
    const published = await provider.getJwks();
    expect(published.keys).toEqual([
      {
        kty: "RSA",
        kid: "k-sign",
        use: "sig",
        alg: "RS256",
        n: "modulus",
        e: "AQAB",
      },
    ]);
  });

  it.each([
    { kty: "EC", crv: "P-256", x: "public-x", y: "public-y" },
    { kty: "OKP", crv: "Ed25519", x: "public-x" },
  ])("projects only public parameters for $kty", async (parameters) => {
    const provider = new EnvSigningKeyProvider({
      OPENSESAME_JWKS_JSON: JSON.stringify({
        keys: [
          {
            ...parameters,
            kid: "asymmetric",
            d: "private-key",
            k: "private-extension",
          },
        ],
      }),
    });
    expect((await provider.getJwks()).keys).toEqual([
      { ...parameters, kid: "asymmetric" },
    ]);
  });

  it.each([
    {
      algorithm: "sha256",
      make: () => generateKeyPairSync("rsa", { modulusLength: 2048 }),
    },
    {
      algorithm: "sha256",
      make: () => generateKeyPairSync("ec", { namedCurve: "P-256" }),
    },
    { algorithm: null, make: () => generateKeyPairSync("ed25519") },
  ])(
    "keeps real asymmetric public keys usable for verification %#",
    async ({ algorithm, make }) => {
      const pair = make();
      const provider = new EnvSigningKeyProvider({
        OPENSESAME_JWKS_JSON: JSON.stringify({
          keys: [pair.privateKey.export({ format: "jwk" })],
        }),
      });
      const published = (await provider.getJwks()).keys[0];
      expect(published).not.toHaveProperty("d");
      const publicKey = createPublicKey({
        key: overlapCast(published),
        format: "jwk",
      });
      const data = Buffer.from("public-verification-regression");
      expect(
        verify(
          algorithm,
          data,
          publicKey,
          sign(algorithm, data, pair.privateKey),
        ),
      ).toBe(true);
    },
  );

  it("does not share mutable public metadata with later signing or public reads", async () => {
    const source = {
      ...jwks.keys[0],
      key_ops: ["verify"],
      x5c: ["public-certificate"],
    };
    const provider = new EnvSigningKeyProvider({
      OPENSESAME_JWKS_JSON: JSON.stringify({ keys: [source] }),
    });
    const published = await provider.getJwks();
    published.keys[0]?.key_ops?.push("sign");
    const exposed = overlapCast(published.keys[0]);
    exposed.x5c.push("modified");
    expect((await provider.getActiveSigningKeys())[0]?.key_ops).toEqual([
      "verify",
    ]);
    expect(overlapCast((await provider.getJwks()).keys[0]).x5c).toEqual([
      "public-certificate",
    ]);
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
