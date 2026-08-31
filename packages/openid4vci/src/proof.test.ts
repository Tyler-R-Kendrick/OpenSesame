/**
 * Adversarial tests for key proof verification.
 *
 * One test per attack, each building the malicious token by hand, because a
 * helper that "builds a proof" cannot build the proofs that matter here.
 */

import type { JsonObject } from "@opensesame/os-domain";
import { exportJWK, generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import {
  asyncRefusalOf,
  decodeHeader,
  generateTestKeyPair,
  importHmacKey,
  jwkJson,
  proofHeader,
  proofPayload,
  signCompact,
  unsecuredCompact,
} from "./__fixtures__/harness.js";
import type { Openid4vciErrorCode } from "./errors.js";
import { MemoryNonceStore } from "./nonce.js";
import { PROOF_JWT_TYP, verifyProofOfPossession } from "./proof.js";

const ISSUER = "https://issuer.example.test";

let nonceStore: MemoryNonceStore;
let holder: Awaited<ReturnType<typeof generateTestKeyPair>>;

beforeEach(async () => {
  nonceStore = new MemoryNonceStore();
  holder = await generateTestKeyPair("ES256");
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function freshNonce(): Promise<string> {
  return (await nonceStore.issue()).nonce;
}

async function refusalCode(proofJwt: string): Promise<Openid4vciErrorCode> {
  return (await asyncRefusalOf(() => verify(proofJwt))).code;
}

function verify(proofJwt: string) {
  return verifyProofOfPossession(proofJwt, {
    credentialIssuer: ISSUER,
    nonceStore,
  });
}

describe("verifyProofOfPossession — the happy path", () => {
  it("accepts a well-formed ES256 proof and returns the embedded key", async () => {
    const nonce = await freshNonce();
    const proof = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      proofPayload(ISSUER, nonce, nowSeconds()),
      holder.privateKey,
    );

    const verified = await verify(proof);
    expect(verified.algorithm).toBe("ES256");
    expect(verified.nonce).toBe(nonce);
    expect(verified.holderJwk.kty).toBe("EC");
    expect(verified.holderJwk.crv).toBe("P-256");
    expect(verified.holderJwk.x).toBe(holder.publicJwk.x);
    expect(verified.holderJwk.y).toBe(holder.publicJwk.y);
  });

  it("accepts EdDSA as well", async () => {
    const ed = await generateTestKeyPair("EdDSA");
    const nonce = await freshNonce();
    const proof = await signCompact(
      proofHeader("EdDSA", ed.publicJwk),
      proofPayload(ISSUER, nonce, nowSeconds()),
      ed.privateKey,
    );
    const verified = await verify(proof);
    expect(verified.algorithm).toBe("EdDSA");
    expect(verified.holderJwk).toEqual({
      kty: "OKP",
      crv: "Ed25519",
      x: ed.publicJwk.x,
    });
  });

  it("returns only key material, dropping anything else the wallet embedded", async () => {
    const nonce = await freshNonce();
    const decorated: JsonObject = {
      ...jwkJson(holder.publicJwk),
      kid: "wallet-key-1",
      alg: "ES256",
      use: "sig",
      // A wallet-chosen string that would otherwise end up issuer-signed
      // inside `cnf.jwk` and be carried to every verifier.
      tracking: "campaign-42",
    };
    const proof = await signCompact(
      { alg: "ES256", typ: PROOF_JWT_TYP, jwk: decorated },
      proofPayload(ISSUER, nonce, nowSeconds()),
      holder.privateKey,
    );

    const verified = await verify(proof);
    expect(Object.keys(verified.holderJwk).sort()).toEqual([
      "crv",
      "kty",
      "x",
      "y",
    ]);
    expect(JSON.stringify(verified.holderJwk)).not.toContain("campaign-42");
  });
});

describe("verifyProofOfPossession — adversarial", () => {
  it("refuses alg: none", async () => {
    const nonce = await freshNonce();
    const proof = unsecuredCompact(
      { alg: "none", typ: PROOF_JWT_TYP, jwk: jwkJson(holder.publicJwk) },
      proofPayload(ISSUER, nonce, nowSeconds()),
    );
    expect(decodeHeader(proof).alg).toBe("none");
    expect(await refusalCode(proof)).toBe("proof_algorithm_not_allowed");
  });

  it("refuses HS256 algorithm confusion", async () => {
    const nonce = await freshNonce();
    // The classic attack: MAC the token with material the verifier publishes.
    const publicBytes = Buffer.from(String(holder.publicJwk.x), "utf8");
    const proof = await signCompact(
      { alg: "HS256", typ: PROOF_JWT_TYP, jwk: jwkJson(holder.publicJwk) },
      proofPayload(ISSUER, nonce, nowSeconds()),
      await importHmacKey(new Uint8Array(publicBytes)),
    );
    expect(await refusalCode(proof)).toBe("proof_algorithm_not_allowed");
  });

  it("refuses the wrong audience", async () => {
    const nonce = await freshNonce();
    const proof = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      proofPayload("https://other-issuer.example.test", nonce, nowSeconds()),
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_audience_mismatch");
  });

  it("refuses a stale iat", async () => {
    const nonce = await freshNonce();
    const proof = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      proofPayload(ISSUER, nonce, nowSeconds() - 3600),
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_not_fresh");
  });

  it("refuses an iat far in the future", async () => {
    const nonce = await freshNonce();
    const proof = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      proofPayload(ISSUER, nonce, nowSeconds() + 3600),
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_not_fresh");
  });

  it("refuses a replayed nonce on the second use", async () => {
    const nonce = await freshNonce();
    const build = (iat: number) =>
      signCompact(
        proofHeader("ES256", holder.publicJwk),
        proofPayload(ISSUER, nonce, iat),
        holder.privateKey,
      );

    await expect(verify(await build(nowSeconds()))).resolves.toBeDefined();
    // The same proof again, and a freshly signed one on the same nonce: both
    // fail, because what was spent is the challenge, not the token.
    expect(await refusalCode(await build(nowSeconds()))).toBe("nonce_replayed");
  });

  it("refuses a nonce that was never issued", async () => {
    const proof = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      proofPayload(ISSUER, "not-a-nonce-we-minted", nowSeconds()),
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("nonce_unknown");
  });

  it("refuses a proof with no nonce at all", async () => {
    const proof = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      { aud: ISSUER, iat: nowSeconds() },
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("nonce_missing");
  });

  it("refuses the wrong typ", async () => {
    const nonce = await freshNonce();
    const proof = await signCompact(
      { alg: "ES256", typ: "JWT", jwk: jwkJson(holder.publicJwk) },
      proofPayload(ISSUER, nonce, nowSeconds()),
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_typ_mismatch");
  });

  it("refuses a header carrying both jwk and kid", async () => {
    const nonce = await freshNonce();
    const proof = await signCompact(
      {
        alg: "ES256",
        typ: PROOF_JWT_TYP,
        jwk: jwkJson(holder.publicJwk),
        kid: "did:example:123#key-1",
      },
      proofPayload(ISSUER, nonce, nowSeconds()),
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_key_reference_invalid");
  });

  it("refuses a proof signed by a key other than the embedded jwk", async () => {
    const attacker = await generateTestKeyPair("ES256");
    const nonce = await freshNonce();
    const proof = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      proofPayload(ISSUER, nonce, nowSeconds()),
      attacker.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_signature_invalid");
  });

  it("leaves the nonce spendable after a failed signature", async () => {
    const attacker = await generateTestKeyPair("ES256");
    const nonce = await freshNonce();
    const forged = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      proofPayload(ISSUER, nonce, nowSeconds()),
      attacker.privateKey,
    );
    await expect(verify(forged)).rejects.toMatchObject({
      code: "proof_signature_invalid",
    });

    // The legitimate wallet's in-flight proof still works: an attacker who
    // saw the challenge could not burn it.
    const honest = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      proofPayload(ISSUER, nonce, nowSeconds()),
      holder.privateKey,
    );
    await expect(verify(honest)).resolves.toBeDefined();
  });

  it("refuses a private key smuggled into the jwk header", async () => {
    const nonce = await freshNonce();
    const privateJwk = await exportJWK(holder.privateKey);
    const proof = await signCompact(
      { alg: "ES256", typ: PROOF_JWT_TYP, jwk: jwkJson(privateJwk) },
      proofPayload(ISSUER, nonce, nowSeconds()),
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_key_reference_invalid");
  });

  it("refuses a curve that does not match the declared algorithm", async () => {
    const { publicKey } = await generateKeyPair("ES384", { extractable: true });
    const wrongCurve = await exportJWK(publicKey);
    const nonce = await freshNonce();
    const proof = await signCompact(
      { alg: "ES256", typ: PROOF_JWT_TYP, jwk: jwkJson(wrongCurve) },
      proofPayload(ISSUER, nonce, nowSeconds()),
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_key_reference_invalid");
  });

  it("refuses an iss claim, which this anonymous grant forbids", async () => {
    const nonce = await freshNonce();
    const proof = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      { ...proofPayload(ISSUER, nonce, nowSeconds()), iss: "wallet-client-id" },
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_issuer_claim_forbidden");
  });

  it("refuses any crit header, having no extensions to satisfy one", async () => {
    const nonce = await freshNonce();
    const proof = await signCompact(
      {
        alg: "ES256",
        typ: PROOF_JWT_TYP,
        jwk: jwkJson(holder.publicJwk),
        crit: ["exp"],
        exp: nowSeconds() + 60,
      },
      proofPayload(ISSUER, nonce, nowSeconds()),
      holder.privateKey,
    );
    expect(await refusalCode(proof)).toBe("proof_algorithm_not_allowed");
  });

  it.each([
    ["not a jwt at all", "hello"],
    ["two segments", "aaa.bbb"],
    ["non-base64url header", "!!!.bbb.ccc"],
  ])("refuses a malformed token: %s", async (_label, token) => {
    expect(await refusalCode(token)).toBe("malformed_proof");
  });

  it("narrows the algorithm list when the caller asks it to", async () => {
    const ed = await generateTestKeyPair("EdDSA");
    const nonce = await freshNonce();
    const proof = await signCompact(
      proofHeader("EdDSA", ed.publicJwk),
      proofPayload(ISSUER, nonce, nowSeconds()),
      ed.privateKey,
    );
    await expect(
      verifyProofOfPossession(proof, {
        credentialIssuer: ISSUER,
        nonceStore,
        allowedAlgorithms: ["ES256"],
      }),
    ).rejects.toMatchObject({ code: "proof_algorithm_not_allowed" });
  });

  it("never quotes the request back in an error message", async () => {
    const nonce = await freshNonce();
    const proof = await signCompact(
      proofHeader("ES256", holder.publicJwk),
      proofPayload("https://attacker-controlled.example", nonce, nowSeconds()),
      holder.privateKey,
    );
    const error = await asyncRefusalOf(() => verify(proof));
    expect(error.message).not.toContain("attacker-controlled");
    expect(error.message).not.toContain(nonce);
    expect(error.cause).toBeUndefined();
  });
});
