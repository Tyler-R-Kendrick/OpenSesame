/**
 * Adversarial suite for the verifier.
 *
 * One test per attack, each derived from a presentation that is otherwise
 * valid. That structure is the point: a test that builds a broken presentation
 * from scratch proves only that garbage is rejected, which any implementation
 * manages. Starting from a presentation the verifier accepts and changing one
 * field proves the check for *that field* exists and is reachable.
 */

import { createHash } from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type IssuedCredential,
  type TestKeyPair,
  createTestKeyPair,
  hmacJwt,
  issueCredential,
  present,
  replaceKeyBindingJwt,
  serializeSdJwt,
  unsecuredJwt,
} from "./__fixtures__/holder.js";
import { type HashAlgorithm, SUPPORTED_HASH_ALGORITHMS } from "./encoding.js";
import { Openid4vpError } from "./errors.js";
import { SUPPORT_MATRIX } from "./index.js";
import { REQUEST_OBJECT_TYP, readSignedCompactJws } from "./jose.js";
import {
  type AuthorizationRequest,
  KNOWN_CREDENTIAL_FORMATS,
  buildAuthorizationRequest,
  buildTransactionData,
  isKnownCredentialFormat,
  isVerifiableCredentialFormat,
  transactionDataHash,
} from "./request.js";
import { InMemoryRequestSessionStore } from "./session.js";
import {
  type TrustedIssuer,
  type VerifiedPresentation,
  type VerifyPresentationInput,
  verifyPresentation,
} from "./verify.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const ISSUER = "https://issuer.example/pid";
const VCT = "https://credentials.example/pid";
const CLIENT_ID = "x509_san_dns:verifier.example";

function sha256Base64url(text: string): string {
  return createHash("sha256")
    .update(Buffer.from(text, "utf8"))
    .digest("base64url");
}

interface PresentOverrides {
  readonly audience?: string;
  readonly nonce?: string;
  readonly issuedAt?: Date;
  readonly issuedAtSeconds?: number;
  readonly transactionDataHashes?: readonly string[] | null;
  readonly transactionDataHashesAlg?: string;
  readonly signingKey?: TestKeyPair;
  readonly credential?: IssuedCredential;
  readonly selected?: readonly string[];
  readonly holderKey?: TestKeyPair;
}

interface IssueOverrides {
  readonly holderPublicJwk?: TestKeyPair;
  readonly expiresAt?: Date;
  readonly typ?: string;
  readonly vct?: string;
  readonly notBefore?: Date;
  readonly rawClaims?: JsonObject;
  readonly selectivelyDisclosable?: JsonObject;
}

interface VerifyOverrides {
  readonly state?: string;
  readonly responseMode?: string;
  readonly vpToken?: JsonObject;
  readonly expectedRequestDigest?: string;
  readonly now?: Date;
  readonly trustedIssuers?: readonly TrustedIssuer[];
  readonly keyBindingMaxAgeSeconds?: number;
  readonly clockSkewSeconds?: number;
}

class Scenario {
  issuerKey!: TestKeyPair;
  holderKey!: TestKeyPair;
  attackerKey!: TestKeyPair;
  request!: AuthorizationRequest;
  store!: InMemoryRequestSessionStore;
  credential!: IssuedCredential;

  async setUp(hashAlgorithms?: readonly HashAlgorithm[]): Promise<void> {
    this.issuerKey = await createTestKeyPair("ES256");
    this.holderKey = await createTestKeyPair("ES256");
    this.attackerKey = await createTestKeyPair("ES256");
    this.request = buildAuthorizationRequest({
      clientId: CLIENT_ID,
      responseMode: "direct_post",
      responseUri: "https://verifier.example/openid4vp/response",
      dcqlQuery: {
        credentials: [{ id: "pid", format: "dc+sd-jwt", vctValues: [VCT] }],
      },
      transactionData: [
        {
          type: "payment_authorization",
          credentialIds: ["pid"],
          hashAlgorithms,
          parameters: { amount: "42.00", currency: "EUR", payee: "Acme GmbH" },
        },
      ],
      now: NOW,
    });
    this.store = new InMemoryRequestSessionStore();
    await this.store.create(this.request);
    this.credential = await this.issue();
  }

  async issue(overrides: IssueOverrides = {}): Promise<IssuedCredential> {
    return await issueCredential({
      issuerKey: this.issuerKey,
      issuer: ISSUER,
      holderPublicJwk: (overrides.holderPublicJwk ?? this.holderKey).publicJwk,
      vct: overrides.vct ?? VCT,
      selectivelyDisclosable: overrides.selectivelyDisclosable ?? {
        given_name: "Ada",
        family_name: "Lovelace",
      },
      plaintext: { country: "GB" },
      issuedAt: new Date(NOW.getTime() - 3_600_000),
      expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 86_400_000),
      notBefore: overrides.notBefore,
      rawClaims: overrides.rawClaims,
      typ: overrides.typ,
    });
  }

  authorizedHashes(): readonly string[] {
    return this.request.transactionData.map((entry) => entry.hash);
  }

  async present(overrides: PresentOverrides = {}): Promise<string> {
    // `null` means "omit the claim entirely" — the missing-hashes attack —
    // while `undefined` means "use the authorized set".
    const hashes =
      overrides.transactionDataHashes === undefined
        ? this.authorizedHashes()
        : overrides.transactionDataHashes;
    const alg =
      hashes === null
        ? undefined
        : (overrides.transactionDataHashesAlg ?? "sha-256");
    return await present({
      credential: overrides.credential ?? this.credential,
      holderKey: overrides.holderKey ?? this.holderKey,
      audience: overrides.audience ?? this.request.audience,
      nonce: overrides.nonce ?? this.request.nonce,
      issuedAt: overrides.issuedAt ?? NOW,
      issuedAtSeconds: overrides.issuedAtSeconds,
      selected: overrides.selected,
      signingKey: overrides.signingKey,
      transactionDataHashes: hashes ?? undefined,
      transactionDataHashesAlg: alg,
    });
  }

  async verify(
    presentation: string,
    overrides: VerifyOverrides = {},
  ): Promise<VerifiedPresentation> {
    return await verifyPresentation({
      response: {
        state: overrides.state ?? this.request.state,
        responseMode: overrides.responseMode ?? "direct_post",
        vpToken: overrides.vpToken ?? { pid: [presentation] },
      },
      store: this.store,
      trustedIssuers: overrides.trustedIssuers ?? [
        { issuer: ISSUER, keys: [this.issuerKey.publicJwk] },
      ],
      expectedRequestDigest:
        overrides.expectedRequestDigest ?? this.request.requestDigest,
      now: overrides.now ?? NOW,
      keyBindingMaxAgeSeconds: overrides.keyBindingMaxAgeSeconds,
      clockSkewSeconds: overrides.clockSkewSeconds,
    });
  }
}

async function refusal(
  run: () => Promise<VerifiedPresentation>,
): Promise<Openid4vpError> {
  try {
    await run();
  } catch (thrown) {
    if (thrown instanceof Openid4vpError) return thrown;
    throw thrown;
  }
  throw new Error("expected the verifier to refuse, but it accepted");
}

describe("verifyPresentation", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = new Scenario();
    await scenario.setUp();
  });

  it("accepts a conforming SD-JWT+KB presentation and returns only evidence", async () => {
    const presentation = await scenario.present();
    const verified = await scenario.verify(presentation);

    expect(verified.claims).toEqual({
      iss: ISSUER,
      vct: VCT,
      country: "GB",
      given_name: "Ada",
      family_name: "Lovelace",
      iat: Math.floor((NOW.getTime() - 3_600_000) / 1000),
      exp: Math.floor((NOW.getTime() + 86_400_000) / 1000),
    });
    expect(verified.boundDigest).toBe(scenario.request.requestDigest);
    expect(verified.assurance.issuer).toBe(ISSUER);
    expect(verified.assurance.credentialType).toBe(VCT);
    expect(verified.assurance.holderBinding).toBe("cryptographic_key_binding");
    expect(verified.assurance.transactionDataTypes).toEqual([
      "payment_authorization",
      "opensesame_request_binding",
    ]);
    expect(verified.verifiedAt).toEqual(NOW);

    // Nothing replayable survives: no VP bytes, no JOSE, no holder key.
    const serialized = JSON.stringify(verified);
    expect(serialized).not.toContain(scenario.credential.issuerJwt);
    expect(serialized).not.toContain(presentation);
    expect(serialized).not.toContain("~");
    expect(serialized).not.toContain("cnf");
    expect(serialized).not.toContain("_sd");
  });

  it("refuses a nonce that is not the one this session issued", async () => {
    const presentation = await scenario.present({ nonce: "not-the-nonce" });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "nonce_mismatch",
    );
  });

  it("refuses a state with no request session", async () => {
    const presentation = await scenario.present();
    expect(
      (
        await refusal(() =>
          scenario.verify(presentation, { state: "yD-yWxU7" }),
        )
      ).code,
    ).toBe("state_unknown");
  });

  it("refuses a presentation addressed to another verifier", async () => {
    const presentation = await scenario.present({
      audience: "x509_san_dns:attacker.example",
    });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "audience_mismatch",
    );
  });

  it("refuses a response arriving by an unrequested response mode", async () => {
    const presentation = await scenario.present();
    expect(
      (
        await refusal(() =>
          scenario.verify(presentation, { responseMode: "dc_api" }),
        )
      ).code,
    ).toBe("response_mode_mismatch");
  });

  it("refuses a KB-JWT with alg none", async () => {
    const sdJwt = serializeSdJwt(scenario.credential);
    const forged = unsecuredJwt(
      { alg: "none", typ: "kb+jwt" },
      {
        iat: Math.floor(NOW.getTime() / 1000),
        aud: scenario.request.audience,
        nonce: scenario.request.nonce,
        sd_hash: sha256Base64url(sdJwt),
      },
    );
    expect(
      (await refusal(() => scenario.verify(`${sdJwt}${forged}`))).code,
    ).toBe("algorithm_not_allowed");
  });

  it("refuses HS256 keyed with the holder's public key (algorithm confusion)", async () => {
    const sdJwt = serializeSdJwt(scenario.credential);
    const forged = hmacJwt(
      { alg: "HS256", typ: "kb+jwt" },
      {
        iat: Math.floor(NOW.getTime() / 1000),
        aud: scenario.request.audience,
        nonce: scenario.request.nonce,
        sd_hash: sha256Base64url(sdJwt),
        transaction_data_hashes: [...scenario.authorizedHashes()],
        transaction_data_hashes_alg: "sha-256",
      },
      scenario.holderKey.publicJwk,
    );
    expect(
      (await refusal(() => scenario.verify(`${sdJwt}${forged}`))).code,
    ).toBe("algorithm_not_allowed");
  });

  it("refuses an unsigned request object", () => {
    const requestObject = unsecuredJwt(
      { alg: "none", typ: REQUEST_OBJECT_TYP },
      {
        client_id: CLIENT_ID,
        response_type: "vp_token",
        response_mode: "direct_post",
        nonce: scenario.request.nonce,
      },
    );
    let code: string | null = null;
    try {
      readSignedCompactJws(requestObject, [REQUEST_OBJECT_TYP], "jose_header");
    } catch (thrown) {
      if (thrown instanceof Openid4vpError) code = thrown.code;
      else throw thrown;
    }
    expect(code).toBe("algorithm_not_allowed");
  });

  it("refuses a malformed JOSE serialization", async () => {
    const presentation = replaceKeyBindingJwt(
      await scenario.present(),
      "eyJhbGciOiJFUzI1NiJ9.notavalidpayload",
    );
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "malformed_presentation",
    );
  });

  it("refuses the same response a second time", async () => {
    const presentation = await scenario.present();
    await scenario.verify(presentation);
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "presentation_replayed",
    );
  });

  it("refuses a credential issued to a different holder key", async () => {
    const foreign = await scenario.issue({
      holderPublicJwk: scenario.attackerKey,
    });
    const presentation = await scenario.present({ credential: foreign });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "holder_binding_failed",
    );
  });

  it("refuses a presentation with no KB-JWT", async () => {
    const presentation = serializeSdJwt(scenario.credential);
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "holder_binding_failed",
    );
  });

  it("refuses a KB-JWT signed by a key the credential does not name", async () => {
    const presentation = await scenario.present({
      signingKey: scenario.attackerKey,
    });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "holder_binding_failed",
    );
  });

  it("refuses a mutated transaction_data entry", async () => {
    const authorized = scenario.request.transactionData[0];
    if (authorized === undefined)
      throw new Error("fixture has no transaction data");
    // A single flipped character in the encoded entry: the wallet signed a
    // hash of something the verifier never authorized.
    const mutated = `${authorized.encoded.slice(0, -1)}${
      authorized.encoded.endsWith("A") ? "B" : "A"
    }`;
    const hashes = [
      sha256Base64url(mutated),
      ...scenario.authorizedHashes().slice(1),
    ];
    const presentation = await scenario.present({
      transactionDataHashes: hashes,
    });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "transaction_data_mismatch",
    );
  });

  it("accepts transaction_data hashes returned in a different order", async () => {
    const reordered = [...scenario.authorizedHashes()].reverse();
    expect(reordered).not.toEqual(scenario.authorizedHashes());
    const presentation = await scenario.present({
      transactionDataHashes: reordered,
    });
    const verified = await scenario.verify(presentation);
    expect(verified.boundDigest).toBe(scenario.request.requestDigest);
  });

  it("refuses an extra transaction_data hash the request never authorized", async () => {
    const smuggled = buildTransactionData({
      type: "payment_authorization",
      credentialIds: ["pid"],
      parameters: { amount: "9999.00", currency: "EUR", payee: "Attacker Ltd" },
    });
    const presentation = await scenario.present({
      transactionDataHashes: [...scenario.authorizedHashes(), smuggled.hash],
    });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "transaction_data_mismatch",
    );
  });

  it("refuses a KB-JWT with no transaction_data_hashes at all", async () => {
    const presentation = await scenario.present({
      transactionDataHashes: null,
    });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "transaction_data_mismatch",
    );
  });

  it("refuses unsupported credential formats by name", async () => {
    // From the response side: a credential typed as something else entirely.
    const foreign = await scenario.issue({ typ: "jwt_vc_json" });
    const presentation = await scenario.present({ credential: foreign });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "format_not_supported",
    );

    // From the request side: mdoc is a format identifier this package knows
    // and declines, rather than one it fails to recognize. The distinction is
    // the whole reason KNOWN_CREDENTIAL_FORMATS is a superset.
    expect(KNOWN_CREDENTIAL_FORMATS).toContain("mso_mdoc");
    expect(isKnownCredentialFormat("mso_mdoc")).toBe(true);
    expect(isVerifiableCredentialFormat("mso_mdoc")).toBe(false);
    expect(isVerifiableCredentialFormat("jwt_vc_json")).toBe(false);
    expect(isVerifiableCredentialFormat("ldp_vc")).toBe(false);
  });

  it("refuses an expired credential", async () => {
    const stale = await scenario.issue({
      expiresAt: new Date(NOW.getTime() - 3_600_000),
    });
    const presentation = await scenario.present({ credential: stale });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "credential_expired",
    );
  });

  it("refuses a response that arrives after the request session lapsed", async () => {
    const presentation = await scenario.present();
    const late = new Date(scenario.request.expiresAt.getTime() + 1000);
    expect(
      (await refusal(() => scenario.verify(presentation, { now: late }))).code,
    ).toBe("request_expired");
  });

  it("refuses a presentation bound to a different request digest", async () => {
    const presentation = await scenario.present();
    expect(
      (
        await refusal(() =>
          scenario.verify(presentation, {
            expectedRequestDigest: `sha256:${"0".repeat(64)}`,
          }),
        )
      ).code,
    ).toBe("digest_mismatch");
  });

  it("never puts credential bytes into an error message", async () => {
    const presentation = await scenario.present();
    const disclosure = scenario.credential.disclosures[0];
    if (disclosure === undefined) throw new Error("fixture has no disclosures");
    const secrets = [
      presentation,
      scenario.credential.issuerJwt,
      disclosure,
      scenario.request.nonce,
      scenario.request.state,
      "Lovelace",
    ];

    const wrongNonce = await scenario.present({ nonce: "wrong" });
    const noHashes = await scenario.present({ transactionDataHashes: null });
    const errors: Openid4vpError[] = [
      await refusal(() => scenario.verify(wrongNonce)),
      await refusal(() => scenario.verify(presentation, { state: "absent" })),
      await refusal(() =>
        scenario.verify(replaceKeyBindingJwt(presentation, "a.b")),
      ),
      await refusal(() => scenario.verify(noHashes)),
      await refusal(() =>
        scenario.verify(presentation, { responseMode: "dc_api" }),
      ),
    ];

    for (const error of errors) {
      const rendered = `${error.name} ${error.message} ${error.stack ?? ""}`;
      for (const secret of secrets) {
        expect(rendered).not.toContain(secret);
      }
      // The cause chain is the other way credential bytes escape.
      expect(error.cause).toBeUndefined();
    }
  });
});

describe("verifyPresentation — bindings the required cases do not reach", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = new Scenario();
    await scenario.setUp();
  });

  it("refuses a credential from an issuer that is not on the allow-list", async () => {
    const presentation = await scenario.present();
    const stranger = await createTestKeyPair("ES256");
    expect(
      (
        await refusal(() =>
          scenario.verify(presentation, {
            trustedIssuers: [{ issuer: ISSUER, keys: [stranger.publicJwk] }],
          }),
        )
      ).code,
    ).toBe("issuer_untrusted");
    expect(
      (
        await refusal(() =>
          scenario.verify(presentation, { trustedIssuers: [] }),
        )
      ).code,
    ).toBe("issuer_untrusted");
  });

  it("refuses a KB-JWT re-attached to a different disclosure selection", async () => {
    // The holder signs `sd_hash` over the exact disclosures presented. Dropping
    // one afterwards keeps every signature valid and changes what was shown.
    const full = await scenario.present();
    const trimmed = `${scenario.credential.issuerJwt}~${
      scenario.credential.disclosures[0] ?? ""
    }~${full.split("~").at(-1) ?? ""}`;
    expect((await refusal(() => scenario.verify(trimmed))).code).toBe(
      "holder_binding_failed",
    );
  });

  it("refuses a key binding proof the wallet sat on for too long", async () => {
    const stale = await scenario.present({
      issuedAt: new Date(NOW.getTime() - 3_600_000),
    });
    expect((await refusal(() => scenario.verify(stale))).code).toBe(
      "holder_binding_failed",
    );
  });

  it("refuses a credential whose vct is not the one the query asked for", async () => {
    const wrongType = await scenario.issue({
      vct: "https://credentials.example/other",
    });
    const presentation = await scenario.present({ credential: wrongType });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "query_not_satisfied",
    );
  });

  it("refuses a vp_token keyed by anything other than the DCQL query id", async () => {
    const presentation = await scenario.present();
    expect(
      (
        await refusal(() =>
          scenario.verify(presentation, { vpToken: { other: [presentation] } }),
        )
      ).code,
    ).toBe("malformed_presentation");
    expect(
      (
        await refusal(() =>
          scenario.verify(presentation, {
            vpToken: { pid: [presentation, presentation] },
          }),
        )
      ).code,
    ).toBe("malformed_presentation");
  });

  it("refuses a hash algorithm the request never offered", async () => {
    const presentation = await scenario.present({
      transactionDataHashes: scenario.request.transactionData.map((entry) =>
        transactionDataHash(entry.encoded, "sha-512"),
      ),
      transactionDataHashesAlg: "sha-512",
    });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "transaction_data_mismatch",
    );
  });

  it("verifies an Ed25519 holder and issuer end to end", async () => {
    const issuerKey = await createTestKeyPair("EdDSA");
    const holderKey = await createTestKeyPair("EdDSA");
    const credential = await issueCredential({
      issuerKey,
      issuer: ISSUER,
      holderPublicJwk: holderKey.publicJwk,
      vct: VCT,
      selectivelyDisclosable: { given_name: "Ada" },
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    });
    const presentation = await present({
      credential,
      holderKey,
      audience: scenario.request.audience,
      nonce: scenario.request.nonce,
      issuedAt: NOW,
      transactionDataHashes: scenario.authorizedHashes(),
      transactionDataHashesAlg: "sha-256",
    });
    const verified = await scenario.verify(presentation, {
      trustedIssuers: [{ issuer: ISSUER, keys: [issuerKey.publicJwk] }],
    });
    expect(verified.assurance.credentialAlgorithm).toBe("EdDSA");
    expect(verified.assurance.keyBindingAlgorithm).toBe("EdDSA");
  });

  it("scopes the subject handle to the verifier so it cannot correlate across them", async () => {
    const presentation = await scenario.present();
    const here = await scenario.verify(presentation);

    const elsewhere = new Scenario();
    await elsewhere.setUp();
    const second = await present({
      credential: await elsewhere.issue({
        holderPublicJwk: scenario.holderKey,
      }),
      holderKey: scenario.holderKey,
      audience: elsewhere.request.audience,
      nonce: elsewhere.request.nonce,
      issuedAt: NOW,
      transactionDataHashes: elsewhere.authorizedHashes(),
      transactionDataHashesAlg: "sha-256",
    });
    const there = await verifyPresentation({
      response: {
        state: elsewhere.request.state,
        responseMode: "direct_post",
        vpToken: { pid: [second] },
      },
      store: elsewhere.store,
      trustedIssuers: [
        { issuer: ISSUER, keys: [elsewhere.issuerKey.publicJwk] },
      ],
      expectedRequestDigest: elsewhere.request.requestDigest,
      now: NOW,
      subjectScope: "https://other-verifier.example",
    });

    expect(here.subjectRef).not.toBe(there.subjectRef);
    expect(here.subjectRef).toMatch(/^sub_[A-Za-z0-9_-]+$/);
  });
});

/**
 * Time claims that are numbers but not moments.
 *
 * `Number.isFinite(1e15)` is true and `new Date(1e18)` is an Invalid Date, so a
 * claim in that region reaches the comparisons as `NaN` — and `NaN` is not
 * greater than a window, not less than a skew, and not before `now`. Each of
 * these presentations was *accepted* before `readEpochSeconds` gained a range,
 * which is worse than a wrong answer: the check was still in the source, still
 * surrounded by passing tests, and doing nothing.
 *
 * Every refusal here is paired with a legitimate value that still passes. A
 * test that only proves `1e15` is refused cannot tell a working range check
 * from a window that refuses everything.
 */
describe("verifyPresentation — timestamps that are not times", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = new Scenario();
    await scenario.setUp();
  });

  it("refuses a key binding iat outside the range a Date can represent", async () => {
    const presentation = await scenario.present({ issuedAtSeconds: 1e15 });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "holder_binding_failed",
    );
  });

  it("refuses a key binding iat from before the epoch", async () => {
    const presentation = await scenario.present({ issuedAtSeconds: -1e15 });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "holder_binding_failed",
    );
  });

  it("still accepts a key binding iat inside the freshness window", async () => {
    const fresh = await scenario.present({
      issuedAt: new Date(NOW.getTime() - 60_000),
    });
    await expect(scenario.verify(fresh)).resolves.toBeDefined();
  });

  it("honours an explicit keyBindingMaxAgeSeconds in both directions", async () => {
    const tenMinutesOld = new Date(NOW.getTime() - 600_000);
    const wide = await scenario.present({ issuedAt: tenMinutesOld });
    const verified = await scenario.verify(wide, {
      keyBindingMaxAgeSeconds: 900,
    });
    expect(verified.assurance.keyBoundAt).toEqual(tenMinutesOld);

    const narrow = new Scenario();
    await narrow.setUp();
    const stale = await narrow.present({ issuedAt: tenMinutesOld });
    expect(
      (
        await refusal(() =>
          narrow.verify(stale, { keyBindingMaxAgeSeconds: 300 }),
        )
      ).code,
    ).toBe("holder_binding_failed");
  });

  it("refuses a key binding proof dated further ahead than the clock skew", async () => {
    const ahead = await scenario.present({
      issuedAt: new Date(NOW.getTime() + 3_600_000),
    });
    expect((await refusal(() => scenario.verify(ahead))).code).toBe(
      "holder_binding_failed",
    );
  });

  it("refuses a credential whose nbf has not arrived", async () => {
    const early = await scenario.issue({
      notBefore: new Date(NOW.getTime() + 3_600_000),
    });
    const presentation = await scenario.present({ credential: early });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "credential_not_yet_valid",
    );
  });

  it("accepts a credential whose nbf has passed", async () => {
    const started = await scenario.issue({
      notBefore: new Date(NOW.getTime() - 3_600_000),
    });
    const presentation = await scenario.present({ credential: started });
    await expect(scenario.verify(presentation)).resolves.toBeDefined();
  });

  it("refuses a credential whose nbf, exp or iat is not a representable instant", async () => {
    // A failed verification leaves the session open, so one scenario carries
    // all three: each of these must be a refusal, and if any is accepted the
    // loop's own second iteration would fail on the consumed session instead —
    // which is why the assertion is inside the loop rather than after it.
    for (const rawClaims of [{ nbf: 1e15 }, { exp: 1e15 }, { iat: -1e15 }]) {
      const forged = await scenario.issue({ rawClaims });
      const presentation = await scenario.present({ credential: forged });
      expect((await refusal(() => scenario.verify(presentation))).code).toBe(
        "malformed_presentation",
      );
    }
  });

  it("reports assurance timestamps a caller can format without throwing", async () => {
    // The Invalid Dates the old reader produced escaped this package as a
    // `RangeError` the first time a caller rendered one, which is precisely the
    // foreign error `errors.ts` promises cannot cross the boundary.
    const presentation = await scenario.present();
    const verified = await scenario.verify(presentation);
    for (const value of [
      verified.assurance.keyBoundAt,
      verified.assurance.credentialIssuedAt,
      verified.assurance.credentialExpiresAt,
    ]) {
      expect(() => (value === null ? "" : value.toISOString())).not.toThrow();
    }
  });

  it("refuses an Invalid Date as now rather than skipping every window", async () => {
    const presentation = await scenario.present();
    expect(
      (
        await refusal(() =>
          scenario.verify(presentation, { now: new Date("not a date") }),
        )
      ).code,
    ).toBe("malformed_presentation");
  });

  it("refuses a clock skew that is not a number", async () => {
    // A deployment reading its tolerances from configuration can produce one,
    // and `NaN * 1000` switches off all three windows at once.
    const presentation = await scenario.present();
    expect(
      (
        await refusal(() =>
          scenario.verify(presentation, { clockSkewSeconds: Number.NaN }),
        )
      ).code,
    ).toBe("malformed_presentation");
  });
});

/**
 * The contract `errors.ts` states, tested as a contract.
 *
 * "Every path out of `verifyPresentation` that is not a `VerifiedPresentation`
 * is an `Openid4vpError`" is a claim about *foreign* errors, so the only way to
 * test it is with the inputs a route handler forwards when it trusts a request
 * body — which is to say, inputs the type system says cannot exist. Each one
 * below produced a `TypeError` or a Node `ERR_INVALID_ARG_TYPE` from inside a
 * dependency before step 0 re-read the arguments.
 */
describe("verifyPresentation — inputs a forwarding route can produce", () => {
  let scenario: Scenario;
  let presentation: string;

  beforeEach(async () => {
    scenario = new Scenario();
    await scenario.setUp();
    presentation = await scenario.present();
  });

  function forwarded(
    fields: Partial<VerifyPresentationInput>,
  ): () => Promise<VerifiedPresentation> {
    const base = {
      response: {
        state: scenario.request.state,
        responseMode: "direct_post",
        vpToken: { pid: [presentation] },
      },
      store: scenario.store,
      trustedIssuers: [
        { issuer: ISSUER, keys: [scenario.issuerKey.publicJwk] },
      ],
      expectedRequestDigest: scenario.request.requestDigest,
      now: NOW,
      ...fields,
    };
    // SAFETY: `base` deliberately violates the declared shape — that violation
    // is the input under test. `overlapCast` keeps it to one documented
    // assertion rather than a chained one.
    const input: VerifyPresentationInput = overlapCast(base);
    return () => verifyPresentation(input);
  }

  it("refuses a response body with no state", async () => {
    const error = await refusal(
      forwarded({
        response: overlapCast({
          responseMode: "direct_post",
          vpToken: { pid: [presentation] },
        }),
      }),
    );
    expect(error).toBeInstanceOf(Openid4vpError);
    expect(error.code).toBe("state_unknown");
  });

  it("refuses a call with no expectedRequestDigest", async () => {
    const error = await refusal(
      forwarded(overlapCast({ expectedRequestDigest: undefined })),
    );
    expect(error).toBeInstanceOf(Openid4vpError);
    expect(error.code).toBe("digest_mismatch");
  });

  it("refuses a response with no vp_token, and one with no response mode", async () => {
    expect(
      (
        await refusal(
          forwarded({
            response: overlapCast({
              state: scenario.request.state,
              responseMode: "direct_post",
            }),
          }),
        )
      ).code,
    ).toBe("malformed_presentation");
    expect(
      (
        await refusal(
          forwarded({
            response: overlapCast({
              state: scenario.request.state,
              vpToken: { pid: [presentation] },
            }),
          }),
        )
      ).code,
    ).toBe("response_mode_mismatch");
  });

  it("refuses a response that is not an object at all", async () => {
    for (const body of [null, "vp_token=...", 7]) {
      const error = await refusal(forwarded({ response: overlapCast(body) }));
      expect(error).toBeInstanceOf(Openid4vpError);
      expect(error.code).toBe("malformed_presentation");
    }
  });

  it("refuses a missing trusted-issuer list without dereferencing it", async () => {
    const error = await refusal(
      forwarded(overlapCast({ trustedIssuers: undefined })),
    );
    expect(error).toBeInstanceOf(Openid4vpError);
    expect(error.code).toBe("issuer_untrusted");
  });
});

/**
 * The two claims in `SUPPORT_MATRIX` that a reader is invited to quote.
 *
 * Both were false. Three hash algorithms were advertised and only `sha-256`
 * could complete a round trip, because the appended request-binding entry
 * always offered `sha-256` alone while the verifier requires the wallet's one
 * choice to appear in *every* authorized entry — so a caller asking for
 * `sha-384` built a request no conforming wallet could answer, and found out
 * after the human in front of the wallet had already consented. And the
 * privacy property the subject handle is built for was scoped on one handle out
 * of two.
 */
describe("verifyPresentation — what the support matrix promises", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = new Scenario();
    await scenario.setUp();
  });

  it("completes the transaction-data round trip under every advertised hash algorithm", async () => {
    expect(SUPPORT_MATRIX.hashAlgorithms).toEqual([
      ...SUPPORTED_HASH_ALGORITHMS,
    ]);
    for (const alg of SUPPORT_MATRIX.hashAlgorithms) {
      const scenario = new Scenario();
      await scenario.setUp([alg]);
      // Every entry, the appended binding one included, must offer what the
      // wallet is about to pick.
      for (const entry of scenario.request.transactionData) {
        expect(entry.hashAlgorithms).toContain(alg);
      }
      const presentation = await scenario.present({
        transactionDataHashes: scenario.request.transactionData.map((entry) =>
          transactionDataHash(entry.encoded, alg),
        ),
        transactionDataHashesAlg: alg,
      });
      const verified = await scenario.verify(presentation);
      expect(verified.boundDigest).toBe(scenario.request.requestDigest);
    }
  });

  it("scopes the credential handle to the verifier so two of them cannot join on it", async () => {
    const here = await scenario.verify(await scenario.present());

    // The same credential bytes, presented a second time to a second verifier.
    // Any two verifiers see a byte-identical issuer-signed JWT, which is what
    // made an unscoped digest of it a global correlator.
    const elsewhere = new Scenario();
    await elsewhere.setUp();
    const there = await verifyPresentation({
      response: {
        state: elsewhere.request.state,
        responseMode: "direct_post",
        vpToken: {
          pid: [
            await present({
              credential: scenario.credential,
              holderKey: scenario.holderKey,
              audience: elsewhere.request.audience,
              nonce: elsewhere.request.nonce,
              issuedAt: NOW,
              transactionDataHashes: elsewhere.authorizedHashes(),
              transactionDataHashesAlg: "sha-256",
            }),
          ],
        },
      },
      store: elsewhere.store,
      trustedIssuers: [
        { issuer: ISSUER, keys: [scenario.issuerKey.publicJwk] },
      ],
      expectedRequestDigest: elsewhere.request.requestDigest,
      now: NOW,
      subjectScope: "https://other-verifier.example",
    });

    expect(there.credentialRef).not.toBe(here.credentialRef);
    expect(here.credentialRef).toMatch(/^cred_[A-Za-z0-9_-]+$/);
  });

  it("keeps the credential handle stable within one verifier", async () => {
    // The property the scoping must not cost: a verifier that sees the same
    // credential twice must still recognize it, or the handle is useless.
    const here = await scenario.verify(await scenario.present());

    const again = new Scenario();
    await again.setUp();
    const second = await verifyPresentation({
      response: {
        state: again.request.state,
        responseMode: "direct_post",
        vpToken: {
          pid: [
            await present({
              credential: scenario.credential,
              holderKey: scenario.holderKey,
              audience: again.request.audience,
              nonce: again.request.nonce,
              issuedAt: NOW,
              transactionDataHashes: again.authorizedHashes(),
              transactionDataHashesAlg: "sha-256",
            }),
          ],
        },
      },
      store: again.store,
      trustedIssuers: [
        { issuer: ISSUER, keys: [scenario.issuerKey.publicJwk] },
      ],
      expectedRequestDigest: again.request.requestDigest,
      now: NOW,
    });

    expect(again.request.audience).toBe(scenario.request.audience);
    expect(second.credentialRef).toBe(here.credentialRef);
  });

  it("refuses a disclosure named __proto__ instead of hiding it in the prototype", async () => {
    // Built through `JSON.parse` because writing the name in an object literal
    // is the very trap under test: it would set this test's own prototype
    // rather than give it the own property an issuer would have digested.
    const smuggled: JsonObject = overlapCast(
      JSON.parse('{"__proto__": {"isAdmin": true}}'),
    );
    const forged = await scenario.issue({ selectivelyDisclosable: smuggled });
    const presentation = await scenario.present({ credential: forged });
    expect((await refusal(() => scenario.verify(presentation))).code).toBe(
      "malformed_presentation",
    );
  });
});

/**
 * The matrix as documentation, since documentation is what it is for.
 *
 * `index.ts` says this object should be quoted rather than paraphrased, which
 * only works while every sentence in it is true. These two were not: the
 * verifier was said to compare the response mode in constant time (it is a
 * plain `!==`, and correctly so — the observed transport is not a secret and
 * has nothing to leak), and the SD-JWT VC profile was cited at a revision this
 * package does not read.
 */
describe("SUPPORT_MATRIX", () => {
  it("cites the SD-JWT VC revision the code was written against", () => {
    // -18 rather than -11. This package is built on RFC 9901 throughout, and
    // -11 predates the RFC — it normatively references
    // draft-ietf-oauth-selective-disclosure-jwt-22 instead. The sibling issuer
    // `@opensesame/openid4vci` cites §2.2.2.3 for the non-disclosable claims,
    // which is -18's numbering (§3.2.2.2 in -11), and pins the same revision in
    // its own matrix: the two packages are the two ends of one credential and
    // must not document different profiles.
    const profile = SUPPORT_MATRIX.credentialSpecifications.find((entry) =>
      entry.status.startsWith("draft-ietf-oauth-sd-jwt-vc"),
    );
    expect(profile?.status).toBe("draft-ietf-oauth-sd-jwt-vc-18");
    expect(profile?.name).toBe(
      "SD-JWT-based Verifiable Digital Credentials (SD-JWT VC)",
    );
  });

  it("claims constant-time comparison only where there is one", () => {
    const claims = SUPPORT_MATRIX.implemented.filter((entry) =>
      entry.includes("constant time"),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("nonce and audience");
    expect(claims[0]).not.toContain("response-mode");
  });
});
