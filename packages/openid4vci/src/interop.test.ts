/**
 * Interoperability: a credential this issuer mints, presented by the verifier
 * package's own wallet fixture, verified by that verifier.
 *
 * This is the test that matters. Everything else in this package proves that
 * the issuer refuses what it should refuse; this proves that what it *emits*
 * is readable by an independently written implementation — one that computes
 * disclosure digests from `node:crypto` rather than reusing our routine, so
 * agreement here is agreement on the format rather than agreement with
 * ourselves.
 *
 * The wallet is `@opensesame/openid4vp`'s `src/__fixtures__/holder.ts`,
 * imported by relative path because a test fixture is deliberately not part of
 * that package's public exports. The two pieces of it used here are
 * `createTestKeyPair` (the holder's key) and `present` (the SD-JWT+KB a
 * conforming wallet would post). Issuance is entirely ours: the fixture's own
 * `issueCredential` is *not* used, which is the whole point.
 *
 * That relative import is also why this package's `tsconfig.json` omits the
 * `rootDir: "src"` that the other workspace packages set. `rootDir` is inert
 * under `noEmit` except for one thing — it makes `tsc` refuse any file outside
 * it, including a sibling package's test fixture reached by path. Dropping it
 * costs nothing that is checked elsewhere and is what lets this test be
 * type-checked rather than merely run.
 *
 * The chain being closed is:
 *
 *     our nonce → the wallet's key proof → our SD-JWT VC
 *       → the wallet's KB-JWT over it → their verifier's decision
 *
 * `cnf.jwk` is the join. We put the key from the verified key proof there; the
 * verifier reads it back out and demands the KB-JWT be signed under it. If our
 * canonicalization of that key were wrong in any way — a stray member, a
 * dropped coordinate, a different encoding — this test would fail at holder
 * binding rather than pass with a warning.
 */

import {
  InMemoryRequestSessionStore,
  SUPPORT_MATRIX as VERIFIER_MATRIX,
  buildAuthorizationRequest,
  verifyPresentation,
} from "@opensesame/openid4vp";
import { describe, expect, it } from "vitest";
import {
  createTestKeyPair,
  present,
} from "../../openid4vp/src/__fixtures__/holder.js";
import {
  generateTestKeyPair,
  proofHeader,
  proofPayload,
  signCompact,
} from "./__fixtures__/harness.js";
import { SUPPORT_MATRIX as ISSUER_MATRIX } from "./index.js";
import {
  FORBIDDEN_CREDENTIAL_CLAIMS,
  deriveDeviceRef,
  deriveSubjectRef,
  issueCredential,
} from "./issue.js";
import { MemoryNonceStore } from "./nonce.js";
import { verifyProofOfPossession } from "./proof.js";

const ISSUER = "https://issuer.example.test";
const VCT = "https://credentials.example.test/opensesame-holder-binding/v1";
const CLIENT_ID = "x509_san_dns:verifier.example.test";
const PEPPER = "interop-test-pepper";
const PRINCIPAL_ID = "prn_01J8XKQ4V7RZ9Y2M3N4P5Q6R7S";
const DEVICE_ID = "dev_01J8XKQ4V7RZ9Y2M3N4P5Q6R7T";

/**
 * Drive the OpenID4VCI half: fresh issuer key, fresh challenge, a real key
 * proof from the wallet's key, and the holder key our issuer will bind to.
 *
 * Returned separately from issuance so each test can choose what to put in the
 * credential without repeating the ceremony.
 */
async function provedHolderKey(
  holder: Awaited<ReturnType<typeof createTestKeyPair>>,
) {
  const issuerKeys = await generateTestKeyPair("ES256");
  const nonces = new MemoryNonceStore();
  const { nonce } = await nonces.issue();
  const proof = await signCompact(
    proofHeader("ES256", holder.publicJwk),
    proofPayload(ISSUER, nonce, Math.floor(Date.now() / 1000)),
    holder.privateKey,
  );
  const verifiedProof = await verifyProofOfPossession(proof, {
    credentialIssuer: ISSUER,
    nonceStore: nonces,
  });
  return { issuerKeys, verifiedProof };
}

describe("interop with @opensesame/openid4vp", () => {
  it("mints a credential their verifier accepts, disclosure by disclosure", async () => {
    const holder = await createTestKeyPair("ES256");
    const { issuerKeys, verifiedProof } = await provedHolderKey(holder);
    // The wallet published `alg` and `kid` inside its JWK; neither survives
    // into `cnf`, and the verifier still binds the presentation to the key.
    expect(Object.keys(verifiedProof.holderJwk).sort()).toEqual([
      "crv",
      "kty",
      "x",
      "y",
    ]);

    const subject = deriveSubjectRef({
      id: PRINCIPAL_ID,
      audience: ISSUER,
      pepper: PEPPER,
    });
    const device = deriveDeviceRef({
      id: DEVICE_ID,
      audience: ISSUER,
      pepper: PEPPER,
    });
    const issued = await issueCredential({
      credentialIssuer: ISSUER,
      vct: VCT,
      subject,
      device,
      holderJwk: verifiedProof.holderJwk,
      signingKey: issuerKeys.privateKey,
      signingAlgorithm: "ES256",
      lifetimeSeconds: 86_400,
    });

    // ---- OpenID4VP: the verifier asks, the wallet answers ----------------
    const request = buildAuthorizationRequest({
      clientId: CLIENT_ID,
      responseMode: "direct_post",
      responseUri: "https://verifier.example.test/openid4vp/response",
      dcqlQuery: {
        credentials: [
          { id: "opensesame", format: "dc+sd-jwt", vctValues: [VCT] },
        ],
      },
    });
    const store = new InMemoryRequestSessionStore();
    await store.create(request);

    const walletCredential = {
      issuerJwt: issued.issuerJwt,
      disclosures: issued.disclosures.map((disclosure) => disclosure.encoded),
    };
    const presentation = await present({
      credential: walletCredential,
      holderKey: holder,
      audience: request.audience,
      nonce: request.nonce,
      transactionDataHashes: request.transactionData.map((entry) => entry.hash),
      transactionDataHashesAlg: "sha-256",
    });

    const verified = await verifyPresentation({
      response: {
        state: request.state,
        responseMode: "direct_post",
        vpToken: { opensesame: [presentation] },
      },
      store,
      trustedIssuers: [{ issuer: ISSUER, keys: [issuerKeys.publicJwk] }],
      expectedRequestDigest: request.requestDigest,
    });

    expect(verified.assurance.issuer).toBe(ISSUER);
    expect(verified.assurance.credentialType).toBe(VCT);
    expect(verified.assurance.holderBinding).toBe("cryptographic_key_binding");
    expect(verified.assurance.format).toBe("dc+sd-jwt");
    expect([...verified.assurance.disclosedClaimNames].sort()).toEqual([
      "device_ref",
      "iat",
      "sub",
    ]);
    expect(verified.claims.iss).toBe(ISSUER);
    expect(verified.claims.vct).toBe(VCT);
    expect(verified.claims.sub).toBe(subject);
    expect(verified.claims.device_ref).toBe(device);
    expect(verified.claims.exp).toBe(issued.expiresAt);

    // What a verifier of ours must never be able to read out of one.
    const names = Object.keys(verified.claims).map((name) =>
      name.toLowerCase(),
    );
    for (const forbidden of FORBIDDEN_CREDENTIAL_CLAIMS) {
      expect(names).not.toContain(forbidden);
    }
    expect(JSON.stringify(verified.claims)).not.toContain(PRINCIPAL_ID);
    expect(JSON.stringify(verified.claims)).not.toContain(DEVICE_ID);
  });

  it("lets the holder withhold the device and the issuance time", async () => {
    const holder = await createTestKeyPair("ES256");
    const { issuerKeys, verifiedProof } = await provedHolderKey(holder);

    const subject = deriveSubjectRef({
      id: PRINCIPAL_ID,
      audience: ISSUER,
      pepper: PEPPER,
    });
    const issued = await issueCredential({
      credentialIssuer: ISSUER,
      vct: VCT,
      subject,
      device: deriveDeviceRef({
        id: DEVICE_ID,
        audience: ISSUER,
        pepper: PEPPER,
      }),
      holderJwk: verifiedProof.holderJwk,
      signingKey: issuerKeys.privateKey,
      signingAlgorithm: "ES256",
      lifetimeSeconds: 86_400,
    });

    const request = buildAuthorizationRequest({
      clientId: CLIENT_ID,
      responseMode: "direct_post",
      responseUri: "https://verifier.example.test/openid4vp/response",
      dcqlQuery: {
        credentials: [
          { id: "opensesame", format: "dc+sd-jwt", vctValues: [VCT] },
        ],
      },
    });
    const store = new InMemoryRequestSessionStore();
    await store.create(request);

    const subjectOnly = issued.disclosures.find(
      (disclosure) => disclosure.claimName === "sub",
    );
    if (subjectOnly === undefined) throw new Error("no sub disclosure");

    const presentation = await present({
      credential: {
        issuerJwt: issued.issuerJwt,
        disclosures: issued.disclosures.map((disclosure) => disclosure.encoded),
      },
      holderKey: holder,
      selected: [subjectOnly.encoded],
      audience: request.audience,
      nonce: request.nonce,
      transactionDataHashes: request.transactionData.map((entry) => entry.hash),
      transactionDataHashesAlg: "sha-256",
    });

    const verified = await verifyPresentation({
      response: {
        state: request.state,
        responseMode: "direct_post",
        vpToken: { opensesame: [presentation] },
      },
      store,
      trustedIssuers: [{ issuer: ISSUER, keys: [issuerKeys.publicJwk] }],
      expectedRequestDigest: request.requestDigest,
    });

    expect(verified.assurance.disclosedClaimNames).toEqual(["sub"]);
    expect(verified.claims.sub).toBe(subject);
    expect(Object.hasOwn(verified.claims, "device_ref")).toBe(false);
    expect(Object.hasOwn(verified.claims, "iat")).toBe(false);
    // Still enough to be worth verifying: issuer, type, validity, holder key.
    expect(verified.claims.iss).toBe(ISSUER);
    expect(verified.claims.vct).toBe(VCT);
  });
});

/**
 * The other half of interoperability: the two matrices describing one wire.
 *
 * `index.ts` on both sides says its `SUPPORT_MATRIX` is written to be quoted
 * verbatim in documentation. Two documents quoting different revisions of the
 * credential profile for the two ends of the *same* credential is not a
 * difference of opinion, it is one of them being wrong — and the test above
 * shows the bytes agree, so the disagreement was only ever in the prose.
 *
 * The pin is -18 and the evidence is the code rather than the larger number:
 * both packages are built on RFC 9901, and -11 predates the RFC, normatively
 * referencing draft-ietf-oauth-selective-disclosure-jwt-22 instead. `issue.ts`
 * cites §2.2.2.3 for the claims that may not be selectively disclosed, which is
 * -18's numbering; the same rule is §3.2.2.2 in -11.
 */
describe("support matrices", () => {
  it("pins the same SD-JWT VC revision on the issuer and the verifier", () => {
    const verifierProfile = VERIFIER_MATRIX.credentialSpecifications.find(
      (entry) => entry.status.startsWith("draft-ietf-oauth-sd-jwt-vc"),
    );
    expect(ISSUER_MATRIX.specifications.sdJwtVc.version).toBe(
      "draft-ietf-oauth-sd-jwt-vc-18",
    );
    expect(verifierProfile?.status).toBe(
      ISSUER_MATRIX.specifications.sdJwtVc.version,
    );
    expect(verifierProfile?.name).toBe(
      ISSUER_MATRIX.specifications.sdJwtVc.title,
    );
    expect(verifierProfile?.published).toBe(
      ISSUER_MATRIX.specifications.sdJwtVc.date,
    );
  });

  it("agrees on the SD-JWT revision underneath it", () => {
    expect(ISSUER_MATRIX.specifications.sdJwt.version).toBe("RFC 9901");
    expect(
      VERIFIER_MATRIX.credentialSpecifications.some(
        (entry) => entry.status === "RFC 9901",
      ),
    ).toBe(true);
  });
});
