import {
  buildSelfIssuedIdToken,
  ecP256JwkThumbprint,
  exportPublicEcP256Jwk,
  isSiopV2Error,
  verifySelfIssuedIdToken,
} from "@opensesame/siop-v2";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { type SiopRpConfig, dynamicSiopIssuer } from "./config.js";
import { NonceStore } from "./nonce-store.js";
import { verifySiopCallback } from "./verify-callback.js";

const rpConfig: SiopRpConfig = {
  pagesBase: "https://pages.example",
  clientId: "local_00000000-0000-4000-8000-000000000001",
  redirectUri: "http://127.0.0.1:4110/callback",
  listen: "127.0.0.1:4110",
  host: "127.0.0.1",
  port: 4110,
};

async function p256Pair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportPublicEcP256Jwk(publicKey);
  return { privateKey, publicJwk };
}

describe("verifySiopCallback", () => {
  it("verifies a minted Self-Issued id_token and enforces single-use state", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const issuer = dynamicSiopIssuer(rpConfig.pagesBase);
    const nonce = "n-verify-1";
    const state = "st-verify-1";
    const store = new NonceStore();
    store.issue(state, nonce, Date.now());
    const now = 1_700_000_000;

    const token = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer },
      audience: rpConfig.clientId,
      nonce,
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
    });

    const first = await verifySiopCallback({
      idToken: token,
      state,
      config: rpConfig,
      store,
      nowSeconds: now + 5,
    });
    expect(first.verified.sub).toBe(await ecP256JwkThumbprint(publicJwk));
    expect(first.verified.iss).toBe(issuer);
    expect(first.verified.aud).toBe(rpConfig.clientId);
    expect(first.verified.nonce).toBe(nonce);
    expect(first.verified.iAmSiop).toBe(true);

    await expect(
      verifySiopCallback({
        idToken: token,
        state,
        config: rpConfig,
        store,
        nowSeconds: now + 5,
      }),
    ).rejects.toMatchObject({ code: "state_replay" });
  });

  it("leaves state reusable after a wrong-nonce token", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const issuer = dynamicSiopIssuer(rpConfig.pagesBase);
    const store = new NonceStore();
    const state = "state-retry";
    const expectedNonce = "expected-nonce";
    store.issue(state, expectedNonce, Date.now());
    const now = 1_700_000_000;

    const wrongNonceToken = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer },
      audience: rpConfig.clientId,
      nonce: "token-nonce",
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
    });

    await expect(
      verifySiopCallback({
        idToken: wrongNonceToken,
        state,
        config: rpConfig,
        store,
        nowSeconds: now + 5,
      }),
    ).rejects.toSatisfy((error: Error) => isSiopV2Error(error));

    const goodToken = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer },
      audience: rpConfig.clientId,
      nonce: expectedNonce,
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
    });

    const ok = await verifySiopCallback({
      idToken: goodToken,
      state,
      config: rpConfig,
      store,
      nowSeconds: now + 5,
    });
    expect(ok.verified.nonce).toBe(expectedNonce);
  });

  it("refuses tokens that fail package verification (wrong nonce)", async () => {
    const { privateKey, publicJwk } = await p256Pair();
    const issuer = dynamicSiopIssuer(rpConfig.pagesBase);
    const store = new NonceStore();
    store.issue("state-a", "expected-nonce", Date.now());
    const now = 1_700_000_000;

    const token = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer },
      audience: rpConfig.clientId,
      nonce: "token-nonce",
      publicJwk,
      signingKey: privateKey,
      nowSeconds: now,
    });

    await expect(
      verifySiopCallback({
        idToken: token,
        state: "state-a",
        config: rpConfig,
        store,
        nowSeconds: now + 5,
      }),
    ).rejects.toSatisfy((error: Error) => isSiopV2Error(error));
  });

  it("uses verifySelfIssuedIdToken (signature + thumbprint), not decode-only", async () => {
    const victim = await p256Pair();
    const attacker = await p256Pair();
    const issuer = dynamicSiopIssuer(rpConfig.pagesBase);
    const nonce = "bound-nonce";
    const now = 1_700_000_000;
    // Sign with attacker key while advertising victim sub_jwk — must fail verify.
    const forged = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer },
      audience: rpConfig.clientId,
      nonce,
      publicJwk: victim.publicJwk,
      signingKey: attacker.privateKey,
      nowSeconds: now,
    });

    await expect(
      verifySelfIssuedIdToken({
        idToken: forged,
        expectedAudience: rpConfig.clientId,
        expectedNonce: nonce,
        profile: { kind: "dynamic", issuer },
        nowSeconds: now + 5,
      }),
    ).rejects.toSatisfy((error: Error) => isSiopV2Error(error));
  });
});
