import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { encodeBase64url, encodeUtf8 } from "./encoding.js";
import { isSiopV2Error } from "./errors.js";
import { buildSelfIssuedIdToken, verifySelfIssuedIdToken } from "./id-token.js";
import { ecP256JwkThumbprint } from "./jwk.js";
import { p256Pair } from "./test-keys.js";

describe("security adversarial — Self-Issued ID Token", () => {
  it("refuses alg none and HS256 header confusion", async () => {
    const payload = {
      iss: "https://self-issued.me/v2",
      sub: "x",
      aud: "https://rp.example/cb",
      nonce: "n",
      exp: 9_999_999_999,
      iat: 1,
    };
    const payloadSegment = encodeBase64url(encodeUtf8(JSON.stringify(payload)));

    for (const alg of ["none", "HS256"] as const) {
      const header = encodeBase64url(encodeUtf8(JSON.stringify({ alg })));
      const token = `${header}.${payloadSegment}.`;
      await expect(
        verifySelfIssuedIdToken({
          idToken: token,
          expectedAudience: "https://rp.example/cb",
          expectedNonce: "n",
          profile: { kind: "static" },
          nowSeconds: 100,
        }),
      ).rejects.toMatchObject({ code: "algorithm_not_allowed" });
    }
  });

  it("refuses private d in sub_jwk", async () => {
    const { privateKey, publicJwk, privateJwk } = await p256Pair();
    const now = 1_700_000_000;
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: "https://rp.example/cb",
      nonce: "n1",
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
    });
    const [h, p, s] = idToken.split(".");
    expect(h && p && s).toBeTruthy();
    const body = JSON.parse(Buffer.from(p ?? "", "base64url").toString("utf8"));
    body.sub_jwk = {
      kty: "EC",
      crv: "P-256",
      x: publicJwk.x,
      y: publicJwk.y,
      d: privateJwk.d,
    };
    const tampered = `${h}.${encodeBase64url(encodeUtf8(JSON.stringify(body)))}.${s}`;

    try {
      await verifySelfIssuedIdToken({
        idToken: tampered,
        expectedAudience: "https://rp.example/cb",
        expectedNonce: "n1",
        profile: { kind: "static" },
        nowSeconds: now,
      });
      expect.unreachable("expected refusal");
    } catch (thrown) {
      expect(thrown instanceof Error && isSiopV2Error(thrown)).toBe(true);
      if (thrown instanceof Error && isSiopV2Error(thrown)) {
        expect(thrown.code).toBe("invalid_sub_jwk");
      }
    }
  });

  it("refuses wrong signing key for sub_jwk", async () => {
    const victim = await p256Pair();
    const attacker = await p256Pair();
    const audience = "https://rp.example/cb";
    const nonce = "n1";
    const now = 1_700_000_000;
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience,
      nonce,
      publicJwk: victim.publicJwk,
      signingKey: attacker.privateKey,
      nowSeconds: now,
    });
    await expect(
      verifySelfIssuedIdToken({
        idToken,
        expectedAudience: audience,
        expectedNonce: nonce,
        profile: { kind: "static" },
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("refuses future iat and expired exp", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const audience = "https://rp.example/cb";
    const nonce = "n1";
    const now = 1_700_000_000;

    const future = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience,
      nonce,
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now + 3600,
    });
    await expect(
      verifySelfIssuedIdToken({
        idToken: future,
        expectedAudience: audience,
        expectedNonce: nonce,
        profile: { kind: "static" },
        nowSeconds: now,
        clockSkewSeconds: 0,
      }),
    ).rejects.toMatchObject({ code: "token_not_fresh" });

    const expired = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience,
      nonce,
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
      ttlSeconds: 60,
    });
    await expect(
      verifySelfIssuedIdToken({
        idToken: expired,
        expectedAudience: audience,
        expectedNonce: nonce,
        profile: { kind: "static" },
        nowSeconds: now + 120,
        clockSkewSeconds: 0,
      }),
    ).rejects.toMatchObject({ code: "token_expired" });
  });

  it("refuses aud arrays with more than one entry", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const audience = "https://rp.example/cb";
    const now = 1_700_000_000;
    const sub = await ecP256JwkThumbprint(publicJwk);
    const idToken = await new SignJWT({
      iss: "https://self-issued.me/v2",
      sub,
      aud: [audience, "https://other.example/cb"],
      nonce: "n1",
      exp: now + 300,
      iat: now,
      sub_jwk: publicJwk,
    })
      .setProtectedHeader({ alg: "ES256" })
      .sign(privateKey);

    await expect(
      verifySelfIssuedIdToken({
        idToken,
        expectedAudience: audience,
        expectedNonce: "n1",
        profile: { kind: "static" },
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "audience_mismatch" });
  });

  it("refuses missing i_am_siop on dynamic profile", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const issuer = "https://siop.example.com";
    const audience = "https://rp.example/cb";
    const now = 1_700_000_000;
    const sub = await ecP256JwkThumbprint(publicJwk);
    const idToken = await new SignJWT({
      iss: issuer,
      sub,
      aud: audience,
      nonce: "dyn",
      exp: now + 300,
      iat: now,
      sub_jwk: publicJwk,
    })
      .setProtectedHeader({ alg: "ES256" })
      .sign(privateKey);

    await expect(
      verifySelfIssuedIdToken({
        idToken,
        expectedAudience: audience,
        expectedNonce: "dyn",
        profile: { kind: "dynamic", issuer },
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });
  });

  it("refuses forged i_am_siop on static profile", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const now = 1_700_000_000;
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: "https://rp.example/cb",
      nonce: "n1",
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
    });
    const [h, p, s] = idToken.split(".");
    const body = JSON.parse(Buffer.from(p ?? "", "base64url").toString("utf8"));
    body.i_am_siop = true;
    const tampered = `${h}.${encodeBase64url(encodeUtf8(JSON.stringify(body)))}.${s}`;

    await expect(
      verifySelfIssuedIdToken({
        idToken: tampered,
        expectedAudience: "https://rp.example/cb",
        expectedNonce: "n1",
        profile: { kind: "static" },
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });
  });
});
