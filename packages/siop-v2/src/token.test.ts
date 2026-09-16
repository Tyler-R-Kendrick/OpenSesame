import { describe, expect, it } from "vitest";
import {
  buildSelfIssuedIdToken,
  exportPublicEcP256Jwk,
  verifySelfIssuedIdToken,
} from "./id-token.js";
import { ecP256JwkThumbprint } from "./jwk.js";
import { MAX_EPOCH_SECONDS, MIN_EPOCH_SECONDS } from "./limits.js";
import { p256Pair } from "./test-keys.js";

describe("Self-Issued ID Token — sign then independently verify", () => {
  it("round-trips static profile with imported public key verify path", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const audience = "https://rp.example/cb";
    const nonce = "n-0S6_WzA2Mj";
    const now = 1_700_000_000;

    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience,
      nonce,
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
      ttlSeconds: 600,
    });

    const verified = await verifySelfIssuedIdToken({
      idToken,
      expectedAudience: audience,
      expectedNonce: nonce,
      profile: { kind: "static" },
      nowSeconds: now + 10,
    });

    expect(verified.iss).toBe("https://self-issued.me/v2");
    expect(verified.sub).toBe(await ecP256JwkThumbprint(publicJwk));
    expect(verified.iAmSiop).toBe(false);
    expect(verified.aud).toBe(audience);
    expect(verified.nonce).toBe(nonce);
  });

  it("round-trips optional kid, alg, and use on sub_jwk", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const enriched = {
      ...publicJwk,
      kid: "kid-1",
      alg: "ES256" as const,
      use: "sig" as const,
    };
    const audience = "https://rp.example/cb";
    const nonce = "jwk-meta-nonce";
    const now = 1_700_000_000;

    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience,
      nonce,
      publicJwk: enriched,
      signingKey: privateKey,
      nowSeconds: now,
    });

    const verified = await verifySelfIssuedIdToken({
      idToken,
      expectedAudience: audience,
      expectedNonce: nonce,
      profile: { kind: "static" },
      nowSeconds: now,
    });
    expect(verified.subJwk.kid).toBe("kid-1");
    expect(verified.subJwk.alg).toBe("ES256");
    expect(verified.subJwk.use).toBe("sig");
  });

  it("accepts aud as a single-element array matching client_id", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const audience = "https://rp.example/cb";
    const nonce = "arr-aud-nonce";
    const now = 1_700_000_000;
    const sub = await ecP256JwkThumbprint(publicJwk);
    const { SignJWT } = await import("jose");
    const idToken = await new SignJWT({
      iss: "https://self-issued.me/v2",
      sub,
      aud: [audience],
      nonce,
      exp: now + 300,
      iat: now,
      sub_jwk: publicJwk,
    })
      .setProtectedHeader({ alg: "ES256" })
      .sign(privateKey);

    const verified = await verifySelfIssuedIdToken({
      idToken,
      expectedAudience: audience,
      expectedNonce: nonce,
      profile: { kind: "static" },
      nowSeconds: now,
    });
    expect(verified.aud).toBe(audience);
  });

  it("round-trips dynamic profile with i_am_siop", async () => {
    const { privateJwk, publicJwk } = await p256Pair();
    const audience = "https://rp.example/cb";
    const nonce = "dynamic-nonce";
    const issuer = "https://siop.example.com";
    const now = 1_700_000_000;

    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer },
      audience,
      nonce,
      publicJwk,
      signingKey: privateJwk,
      nowSeconds: now,
    });

    const verified = await verifySelfIssuedIdToken({
      idToken,
      expectedAudience: audience,
      expectedNonce: nonce,
      profile: { kind: "dynamic", issuer },
      nowSeconds: now,
    });

    expect(verified.iss).toBe(issuer);
    expect(verified.iAmSiop).toBe(true);
    expect(verified.profile).toBe("dynamic");
  });

  it("allows loopback HTTP dynamic issuers for local dogfood", async () => {
    const { privateJwk, publicJwk } = await p256Pair();
    const audience = "https://rp.example/cb";
    const nonce = "loopback-nonce";
    const issuer = "http://localhost:5180/identity/siop";
    const now = 1_700_000_000;

    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer },
      audience,
      nonce,
      publicJwk,
      signingKey: privateJwk,
      nowSeconds: now,
    });

    const verified = await verifySelfIssuedIdToken({
      idToken,
      expectedAudience: audience,
      expectedNonce: nonce,
      profile: { kind: "dynamic", issuer },
      nowSeconds: now,
    });
    expect(verified.iss).toBe(issuer);
    expect(verified.iAmSiop).toBe(true);
  });

  it("refuses non-loopback HTTP dynamic issuers at mint and verify", async () => {
    const { privateJwk, publicJwk } = await p256Pair();
    const audience = "https://rp.example/cb";
    const nonce = "evil-nonce";
    const evilIssuer = "http://evil.example/identity/siop";
    const now = 1_700_000_000;
    const evilProfile = { kind: "dynamic" as const, issuer: evilIssuer };

    await expect(
      buildSelfIssuedIdToken({
        profile: evilProfile,
        audience,
        nonce,
        publicJwk,
        signingKey: privateJwk,
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });

    const { privateKey, publicJwk: loopbackPub } = await p256Pair();
    const loopbackIssuer = "http://localhost:5180/identity/siop";
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer: loopbackIssuer },
      audience,
      nonce,
      publicJwk: loopbackPub,
      signingKey: privateKey,
      nowSeconds: now,
    });

    await expect(
      verifySelfIssuedIdToken({
        idToken,
        expectedAudience: audience,
        expectedNonce: nonce,
        profile: evilProfile,
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });
  });
});

describe("ID Token build limits", () => {
  it("refuses empty audience or nonce at mint", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const base = {
      profile: { kind: "static" as const },
      publicJwk,
      signingKey: privateKey,
      nowSeconds: 1_700_000_000,
    };
    await expect(
      buildSelfIssuedIdToken({ ...base, audience: "", nonce: "n" }),
    ).rejects.toMatchObject({ code: "malformed_request" });
    await expect(
      buildSelfIssuedIdToken({
        ...base,
        audience: "https://rp.example/cb",
        nonce: "",
      }),
    ).rejects.toMatchObject({ code: "malformed_request" });
  });

  it("refuses nowSeconds outside the accepted epoch window", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const base = {
      profile: { kind: "static" as const },
      audience: "https://rp.example/cb",
      nonce: "n1",
      publicJwk,
      signingKey: privateKey,
    };
    await expect(
      buildSelfIssuedIdToken({
        ...base,
        nowSeconds: MIN_EPOCH_SECONDS - 1,
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(
      buildSelfIssuedIdToken({
        ...base,
        nowSeconds: MAX_EPOCH_SECONDS + 1,
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(
      buildSelfIssuedIdToken({ ...base, nowSeconds: 1.5 }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("exportPublicEcP256Jwk preserves kid when present on the key", async () => {
    const { privateKey } = await p256Pair();
    const exported = await exportPublicEcP256Jwk(privateKey);
    expect(exported.kty).toBe("EC");
    expect(exported.crv).toBe("P-256");
    expect(exported.x.length).toBeGreaterThan(0);
    expect(exported.y.length).toBeGreaterThan(0);
  });
});
