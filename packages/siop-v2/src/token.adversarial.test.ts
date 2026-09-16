import { describe, expect, it } from "vitest";
import { encodeBase64url, encodeUtf8 } from "./encoding.js";
import { isSiopV2Error } from "./errors.js";
import { buildSelfIssuedIdToken, verifySelfIssuedIdToken } from "./id-token.js";
import { ecP256JwkThumbprint } from "./jwk.js";
import { p256Pair } from "./test-keys.js";

describe("adversarial ID Token cases", () => {
  it("refuses alg none before signature verify", async () => {
    const header = encodeBase64url(encodeUtf8('{"alg":"none"}'));
    const payload = encodeBase64url(
      encodeUtf8(
        JSON.stringify({
          iss: "https://self-issued.me/v2",
          sub: "x",
          aud: "https://rp.example/cb",
          nonce: "n",
          exp: 9_999_999_999,
          iat: 1,
        }),
      ),
    );
    const noneToken = `${header}.${payload}.`;

    await expect(
      verifySelfIssuedIdToken({
        idToken: noneToken,
        expectedAudience: "https://rp.example/cb",
        expectedNonce: "n",
        profile: { kind: "static" },
        nowSeconds: 100,
      }),
    ).rejects.toMatchObject({ code: "algorithm_not_allowed" });
  });

  it("refuses signature when signing key does not match sub_jwk", async () => {
    const { privateKey } = await p256Pair();
    const other = await p256Pair();
    const audience = "https://rp.example/cb";
    const nonce = "n1";
    const now = 1_700_000_000;

    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience,
      nonce,
      publicJwk: other.publicJwk,
      signingKey: privateKey,
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

  it("refuses wrong aud and wrong nonce", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const now = 1_700_000_000;
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: "https://rp.example/cb",
      nonce: "expected-nonce",
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
    });

    await expect(
      verifySelfIssuedIdToken({
        idToken,
        expectedAudience: "https://other.example/cb",
        expectedNonce: "expected-nonce",
        profile: { kind: "static" },
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "audience_mismatch" });

    await expect(
      verifySelfIssuedIdToken({
        idToken,
        expectedAudience: "https://rp.example/cb",
        expectedNonce: "wrong-nonce",
        profile: { kind: "static" },
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "nonce_mismatch" });
  });

  it("refuses multi-entry aud arrays", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const audience = "https://rp.example/cb";
    const now = 1_700_000_000;
    const sub = await ecP256JwkThumbprint(publicJwk);
    const { SignJWT } = await import("jose");
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
    const payload = JSON.parse(
      Buffer.from(p ?? "", "base64url").toString("utf8"),
    );
    payload.sub_jwk = {
      kty: "EC",
      crv: "P-256",
      x: publicJwk.x,
      y: publicJwk.y,
      d: privateJwk.d,
    };
    const tampered = `${h}.${encodeBase64url(encodeUtf8(JSON.stringify(payload)))}.${s}`;

    try {
      await verifySelfIssuedIdToken({
        idToken: tampered,
        expectedAudience: "https://rp.example/cb",
        expectedNonce: "n1",
        profile: { kind: "static" },
        nowSeconds: now,
      });
      expect.unreachable("expected refusal");
    } catch (err) {
      expect(err instanceof Error && isSiopV2Error(err)).toBe(true);
      if (err instanceof Error && isSiopV2Error(err)) {
        expect(err.code).toBe("invalid_sub_jwk");
      }
    }
  });

  it("refuses expired tokens", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const now = 1_700_000_000;
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: "https://rp.example/cb",
      nonce: "n1",
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
      ttlSeconds: 60,
    });

    await expect(
      verifySelfIssuedIdToken({
        idToken,
        expectedAudience: "https://rp.example/cb",
        expectedNonce: "n1",
        profile: { kind: "static" },
        nowSeconds: now + 120,
        clockSkewSeconds: 0,
      }),
    ).rejects.toMatchObject({ code: "token_expired" });
  });

  it("refuses thumbprint mismatch when sub is altered", async () => {
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
    const payload = JSON.parse(
      Buffer.from(p ?? "", "base64url").toString("utf8"),
    );
    payload.sub = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const tampered = `${h}.${encodeBase64url(encodeUtf8(JSON.stringify(payload)))}.${s}`;

    await expect(
      verifySelfIssuedIdToken({
        idToken: tampered,
        expectedAudience: "https://rp.example/cb",
        expectedNonce: "n1",
        profile: { kind: "static" },
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "subject_mismatch" });
  });
});
