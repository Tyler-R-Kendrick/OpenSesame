/**
 * The whole issuance ceremony, end to end, with nothing stubbed.
 *
 * Offer → pre-authorized code → nonce → key proof → credential, driven through
 * the same functions a gateway would call, with keys generated in this process
 * and no external service, issuer account, or network access anywhere.
 */

import { describe, expect, it } from "vitest";
import {
  decodePayload,
  generateTestKeyPair,
  preAuthorizedGrantParameters,
  proofHeader,
  proofPayload,
  readString,
  resolveDisclosures,
  signCompact,
} from "./__fixtures__/harness.js";
import { Openid4vciError } from "./errors.js";
import { deriveDeviceRef, deriveSubjectRef, issueCredential } from "./issue.js";
import { buildIssuerMetadata, issuerMetadataUrl } from "./metadata.js";
import { MemoryNonceStore } from "./nonce.js";
import {
  MemoryPreAuthorizedCodeStore,
  PRE_AUTHORIZED_CODE_GRANT_TYPE,
  createCredentialOffer,
} from "./offer.js";
import { verifyProofOfPossession } from "./proof.js";

const ISSUER = "https://issuer.example.test";
const CONFIGURATION_ID = "opensesame-holder-binding";
const VCT = "https://credentials.example.test/opensesame-holder-binding/v1";
const PEPPER = "flow-test-pepper";
const PRINCIPAL_ID = "prn_01J8XKQ4V7RZ9Y2M3N4P5Q6R7S";
const DEVICE_ID = "dev_01J8XKQ4V7RZ9Y2M3N4P5Q6R7T";

describe("offer → code → nonce → proof → credential", () => {
  it("issues a credential the whole chain agrees on", async () => {
    // ---- the issuer's own key and published metadata --------------------
    const issuerKeys = await generateTestKeyPair("ES256");
    const metadata = buildIssuerMetadata({
      credentialIssuer: ISSUER,
      credentialEndpoint: `${ISSUER}/credential`,
      nonceEndpoint: `${ISSUER}/nonce`,
      credentialConfigurationId: CONFIGURATION_ID,
      vct: VCT,
      credentialSigningAlgorithm: "ES256",
      proofSigningAlgorithms: ["ES256", "EdDSA"],
    });
    expect(issuerMetadataUrl(ISSUER)).toBe(
      `${ISSUER}/.well-known/openid-credential-issuer`,
    );

    const codes = new MemoryPreAuthorizedCodeStore();
    const nonces = new MemoryNonceStore();

    // ---- 1. the issuer mints an offer and shows a link -------------------
    const created = createCredentialOffer({
      credentialIssuer: ISSUER,
      credentialConfigurationIds: [CONFIGURATION_ID],
      offerUri: `${ISSUER}/offers/9f2c`,
      txCode: {
        inputMode: "numeric",
        length: 4,
        description: "Shown on screen",
      },
      txCodeValue: "4821",
    });
    await codes.register(created.grant);

    // ---- 2. the wallet reads the link, fetches the offer object ----------
    const query = created.offerLink.slice(created.offerLink.indexOf("?") + 1);
    const offerUri = new URLSearchParams(query).get("credential_offer_uri");
    expect(offerUri).toBe(`${ISSUER}/offers/9f2c`);
    // ...which, in a deployment, is an HTTPS GET. Here it is the object we
    // handed the caller to serve.
    const offer = created.offer;
    expect(offer.credential_issuer).toBe(metadata.credential_issuer);
    const preAuthorizedCode = readString(
      preAuthorizedGrantParameters(offer),
      "pre-authorized_code",
    );

    // ---- 3. the token endpoint spends the code once ----------------------
    const redeemed = await codes.redeem(preAuthorizedCode, "4821");
    expect(redeemed.credentialConfigurationIds).toEqual([CONFIGURATION_ID]);

    // ---- 4. the wallet asks for a challenge ------------------------------
    const { nonce } = await nonces.issue();

    // ---- 5. the wallet proves it holds a key -----------------------------
    const holderKeys = await generateTestKeyPair("ES256");
    const proof = await signCompact(
      proofHeader("ES256", holderKeys.publicJwk),
      proofPayload(ISSUER, nonce, Math.floor(Date.now() / 1000)),
      holderKeys.privateKey,
    );
    const verified = await verifyProofOfPossession(proof, {
      credentialIssuer: ISSUER,
      nonceStore: nonces,
    });

    // ---- 6. the credential endpoint mints ---------------------------------
    const issued = await issueCredential({
      credentialIssuer: ISSUER,
      vct: VCT,
      subject: deriveSubjectRef({
        id: PRINCIPAL_ID,
        audience: ISSUER,
        pepper: PEPPER,
      }),
      device: deriveDeviceRef({
        id: DEVICE_ID,
        audience: ISSUER,
        pepper: PEPPER,
      }),
      holderJwk: verified.holderJwk,
      signingKey: issuerKeys.privateKey,
      signingAlgorithm: "ES256",
      lifetimeSeconds: 86_400,
    });

    // ---- what came out ----------------------------------------------------
    const resolved = resolveDisclosures(issued.credential);
    expect(resolved.claims.iss).toBe(ISSUER);
    expect(resolved.claims.vct).toBe(VCT);
    expect(resolved.claims.cnf).toEqual({
      jwk: {
        kty: "EC",
        crv: "P-256",
        x: holderKeys.publicJwk.x,
        y: holderKeys.publicJwk.y,
      },
    });
    expect([...resolved.disclosedNames].sort()).toEqual([
      "device_ref",
      "iat",
      "sub",
    ]);
    expect(issued.credential).not.toContain(PRINCIPAL_ID);
    expect(issued.credential).not.toContain(DEVICE_ID);

    // ---- and what the ceremony spent --------------------------------------
    await expect(
      codes.redeem(preAuthorizedCode, "4821"),
    ).rejects.toBeInstanceOf(Openid4vciError);
    const replay = await signCompact(
      proofHeader("ES256", holderKeys.publicJwk),
      proofPayload(ISSUER, nonce, Math.floor(Date.now() / 1000)),
      holderKeys.privateKey,
    );
    await expect(
      verifyProofOfPossession(replay, {
        credentialIssuer: ISSUER,
        nonceStore: nonces,
      }),
    ).rejects.toMatchObject({ wireError: "invalid_nonce" });
  });

  it("binds the credential to the key that signed the proof, not the one asked for", async () => {
    const issuerKeys = await generateTestKeyPair("ES256");
    const nonces = new MemoryNonceStore();
    const holderKeys = await generateTestKeyPair("EdDSA");

    const { nonce } = await nonces.issue();
    const proof = await signCompact(
      proofHeader("EdDSA", holderKeys.publicJwk),
      proofPayload(ISSUER, nonce, Math.floor(Date.now() / 1000)),
      holderKeys.privateKey,
    );
    const verified = await verifyProofOfPossession(proof, {
      credentialIssuer: ISSUER,
      nonceStore: nonces,
    });

    const issued = await issueCredential({
      credentialIssuer: ISSUER,
      vct: VCT,
      subject: deriveSubjectRef({
        id: PRINCIPAL_ID,
        audience: ISSUER,
        pepper: PEPPER,
      }),
      holderJwk: verified.holderJwk,
      signingKey: issuerKeys.privateKey,
      signingAlgorithm: "ES256",
      lifetimeSeconds: 3600,
    });

    const payload = decodePayload(issued.issuerJwt);
    expect(payload.cnf).toEqual({
      jwk: { kty: "OKP", crv: "Ed25519", x: holderKeys.publicJwk.x },
    });
  });
});
