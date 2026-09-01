import { FORBIDDEN_URL_PARAMS, isJsonObject } from "@opensesame/os-domain";
import { compactVerify, importJWK } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decodeHeader,
  decodePayload,
  generateTestKeyPair,
  readDisclosure,
  readStringArray,
  resolveDisclosures,
  tamperDisclosure,
} from "./__fixtures__/harness.js";
import { Openid4vciError } from "./errors.js";
import {
  FORBIDDEN_CREDENTIAL_CLAIMS,
  type IssueCredentialInput,
  SD_ALG,
  SD_JWT_VC_TYP,
  type SubjectRef,
  deriveDeviceRef,
  deriveSubjectRef,
  issueCredential,
} from "./issue.js";

const ISSUER = "https://issuer.example.test";
const VCT = "https://credentials.example.test/opensesame-holder-binding/v1";
const PEPPER = "test-pepper-not-a-real-one";
/**
 * The value that must never appear anywhere in the credential. It is the
 * OpenSesame-internal join key that every content test searches for.
 */
const PRINCIPAL_ID = "prn_01J8XKQ4V7RZ9Y2M3N4P5Q6R7S";

let issuerKeys: Awaited<ReturnType<typeof generateTestKeyPair>>;
let holderKeys: Awaited<ReturnType<typeof generateTestKeyPair>>;

beforeEach(async () => {
  issuerKeys = await generateTestKeyPair("ES256");
  holderKeys = await generateTestKeyPair("ES256");
});

function subject(): SubjectRef {
  return deriveSubjectRef({
    id: PRINCIPAL_ID,
    audience: ISSUER,
    pepper: PEPPER,
  });
}

async function mint(overrides: Partial<IssueCredentialInput> = {}) {
  return await issueCredential({
    credentialIssuer: ISSUER,
    vct: VCT,
    subject: subject(),
    holderJwk: holderKeys.publicJwk,
    signingKey: issuerKeys.privateKey,
    signingAlgorithm: "ES256",
    lifetimeSeconds: 86_400,
    ...overrides,
  });
}

describe("pairwise references", () => {
  it("never reveals the id it was derived from", () => {
    const reference = subject();
    expect(reference).not.toContain(PRINCIPAL_ID);
    expect(
      Buffer.from(reference.slice(4), "base64url").toString("utf8"),
    ).not.toContain(PRINCIPAL_ID);
  });

  it("is stable for one audience and different across audiences", () => {
    const a = deriveSubjectRef({
      id: PRINCIPAL_ID,
      audience: ISSUER,
      pepper: PEPPER,
    });
    const b = deriveSubjectRef({
      id: PRINCIPAL_ID,
      audience: ISSUER,
      pepper: PEPPER,
    });
    const other = deriveSubjectRef({
      id: PRINCIPAL_ID,
      audience: "https://other.example.test",
      pepper: PEPPER,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it("separates subject and device references for the same id", () => {
    const asSubject = deriveSubjectRef({
      id: "dev-1",
      audience: ISSUER,
      pepper: PEPPER,
    });
    const asDevice = deriveDeviceRef({
      id: "dev-1",
      audience: ISSUER,
      pepper: PEPPER,
    });
    expect(asSubject.slice(4)).not.toBe(asDevice.slice(4));
  });

  it("refuses an empty pepper, which would make it a dictionary lookup", () => {
    expect(() =>
      deriveSubjectRef({ id: PRINCIPAL_ID, audience: ISSUER, pepper: "" }),
    ).toThrow(Openid4vciError);
  });

  it("refuses a raw string cast into the branded type", async () => {
    // The brand is a compile-time guard, so the test has to defeat it to
    // reach the runtime one — which is the guard that actually matters.
    // A canonical principal id is exactly what must never reach `cnf`.
    // SAFETY: forging the brand to reach the checked shape invariant.
    const forged = PRINCIPAL_ID as SubjectRef;
    await expect(mint({ subject: forged })).rejects.toMatchObject({
      code: "subject_reference_invalid",
    });
  });
});

describe("issueCredential — shape", () => {
  it("mints an SD-JWT VC the issuer key verifies", async () => {
    const issued = await mint();
    expect(issued.credential.endsWith("~")).toBe(true);
    expect(issued.mediaType).toBe("application/dc+sd-jwt");

    const header = decodeHeader(issued.issuerJwt);
    expect(header.typ).toBe(SD_JWT_VC_TYP);
    expect(header.alg).toBe("ES256");

    const key = await importJWK(issuerKeys.publicJwk, "ES256");
    await expect(
      compactVerify(issued.issuerJwt, key, { algorithms: ["ES256"] }),
    ).resolves.toBeDefined();
  });

  it("keeps iss, vct, cnf and exp in plaintext and everything else disclosable", async () => {
    const issued = await mint();
    const payload = decodePayload(issued.issuerJwt);
    expect(Object.keys(payload).sort()).toEqual([
      "_sd",
      "_sd_alg",
      "cnf",
      "exp",
      "iss",
      "vct",
    ]);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.vct).toBe(VCT);
    expect(payload._sd_alg).toBe(SD_ALG);
    expect(payload.cnf).toEqual({
      jwk: {
        kty: "EC",
        crv: "P-256",
        x: holderKeys.publicJwk.x,
        y: holderKeys.publicJwk.y,
      },
    });
  });

  it("omits nbf, which would put iat back in the clear", async () => {
    const payload = decodePayload((await mint()).issuerJwt);
    expect(Object.hasOwn(payload, "nbf")).toBe(false);
    expect(Object.hasOwn(payload, "iat")).toBe(false);
  });

  it("uses a fresh salt per claim and per issuance", async () => {
    const first = await mint();
    const second = await mint();
    const salts = [...first.disclosures, ...second.disclosures].map(
      (disclosure) => readDisclosure(disclosure.encoded)[0],
    );
    expect(new Set(salts).size).toBe(salts.length);
    // Same claims, different digests: two credentials are not linkable by
    // digest equality.
    expect(first.disclosures[0]?.digest).not.toBe(
      second.disclosures[0]?.digest,
    );
  });

  it("sorts _sd so array position does not identify a claim", async () => {
    const issued = await mint({
      device: deriveDeviceRef({
        id: "device-9",
        audience: ISSUER,
        pepper: PEPPER,
      }),
    });
    const sd = readStringArray(decodePayload(issued.issuerJwt), "_sd");
    expect(sd).toEqual([...sd].sort());
    expect(sd).toHaveLength(3);
  });
});

describe("issueCredential — selective disclosure", () => {
  it("reconstructs exactly the disclosed claims and no others", async () => {
    const device = deriveDeviceRef({
      id: "device-9",
      audience: ISSUER,
      pepper: PEPPER,
    });
    const issued = await mint({ device });

    const everything = resolveDisclosures(issued.credential);
    expect([...everything.disclosedNames].sort()).toEqual([
      "device_ref",
      "iat",
      "sub",
    ]);
    expect(everything.claims.sub).toBe(subject());
    expect(everything.claims.device_ref).toBe(device);
    expect(everything.claims.iat).toBe(issued.issuedAt);

    // A holder presenting only `sub` — the verifier learns the subject and
    // neither the device nor when we issued it.
    const subjectOnly = issued.disclosures.find((d) => d.claimName === "sub");
    expect(subjectOnly).toBeDefined();
    const narrowed = resolveDisclosures(
      `${issued.issuerJwt}~${subjectOnly?.encoded}~`,
    );
    expect(narrowed.disclosedNames).toEqual(["sub"]);
    expect(Object.hasOwn(narrowed.claims, "iat")).toBe(false);
    expect(Object.hasOwn(narrowed.claims, "device_ref")).toBe(false);
    // The plaintext claims are still there, because they were never hidden.
    expect(narrowed.claims.iss).toBe(ISSUER);
    expect(narrowed.claims.vct).toBe(VCT);

    // A holder presenting nothing at all still proves issuer, type and key.
    const bare = resolveDisclosures(`${issued.issuerJwt}~`);
    expect(bare.disclosedNames).toEqual([]);
    expect(Object.hasOwn(bare.claims, "sub")).toBe(false);
    expect(bare.claims.cnf).toBeDefined();
  });

  it("fails a tampered disclosure at its digest", async () => {
    const issued = await mint();
    const first = issued.disclosures.at(0);
    if (first === undefined) throw new Error("nothing was disclosed");
    const tampered = tamperDisclosure(first.encoded);
    expect(tampered).not.toBe(first.encoded);
    expect(() =>
      resolveDisclosures(`${issued.issuerJwt}~${tampered}~`),
    ).toThrow("disclosure digest not found");
  });

  it("fails a disclosure smuggled in from another credential", async () => {
    const mine = await mint();
    const theirs = await mint();
    const foreign = theirs.disclosures[0];
    expect(foreign).toBeDefined();
    expect(() =>
      resolveDisclosures(`${mine.issuerJwt}~${foreign?.encoded}~`),
    ).toThrow("disclosure digest not found");
  });

  it("computes digests over the base64url text, per RFC 9901 §4.2.3", async () => {
    const { createHash } = await import("node:crypto");
    const issued = await mint();
    for (const disclosure of issued.disclosures) {
      const expected = createHash("sha256")
        .update(Buffer.from(disclosure.encoded, "ascii"))
        .digest("base64url");
      expect(disclosure.digest).toBe(expected);
      // Hashing the decoded bytes instead would be self-consistent and wrong.
      const wrong = createHash("sha256")
        .update(Buffer.from(disclosure.encoded, "base64url"))
        .digest("base64url");
      expect(disclosure.digest).not.toBe(wrong);
    }
  });
});

describe("issueCredential — what the credential must not say", () => {
  it("carries no scope, role, grant or entitlement claim", async () => {
    const issued = await mint({
      device: deriveDeviceRef({
        id: "device-9",
        audience: ISSUER,
        pepper: PEPPER,
      }),
    });
    const resolved = resolveDisclosures(issued.credential);
    const names = Object.keys(resolved.claims).map((name) =>
      name.toLowerCase(),
    );
    for (const forbidden of FORBIDDEN_CREDENTIAL_CLAIMS) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("carries no forbidden parameter name from the shared deny-list", async () => {
    const issued = await mint();
    const resolved = resolveDisclosures(issued.credential);
    const names = Object.keys(resolved.claims).map((name) =>
      name.toLowerCase(),
    );
    for (const forbidden of FORBIDDEN_URL_PARAMS) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("carries no canonical principal id, anywhere in its bytes", async () => {
    const issued = await mint({
      device: deriveDeviceRef({
        id: PRINCIPAL_ID,
        audience: ISSUER,
        pepper: PEPPER,
      }),
    });
    expect(issued.credential).not.toContain(PRINCIPAL_ID);
    const resolved = resolveDisclosures(issued.credential);
    expect(JSON.stringify(resolved.claims)).not.toContain(PRINCIPAL_ID);
  });

  it("carries no private key material", async () => {
    const issued = await mint();
    const cnf = decodePayload(issued.issuerJwt).cnf;
    if (!isJsonObject(cnf)) throw new Error("cnf is not an object");
    const jwk = cnf.jwk;
    if (!isJsonObject(jwk)) throw new Error("cnf.jwk is not an object");
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(jwk.d).toBeUndefined();
  });

  it("refuses to sign a holder key carrying a private scalar", async () => {
    const { exportJWK } = await import("jose");
    const privateJwk = await exportJWK(holderKeys.privateKey);
    await expect(mint({ holderJwk: privateJwk })).rejects.toMatchObject({
      code: "issuance_refused",
    });
  });

  it("refuses an unsupported signing algorithm and a non-positive lifetime", async () => {
    // The check exists for a deployment reaching this from untyped config.
    // SAFETY: deliberately asserting a value the runtime contract rejects.
    const outsideTheAllowList = "RS256" as "ES256";
    await expect(
      mint({ signingAlgorithm: outsideTheAllowList }),
    ).rejects.toMatchObject({ code: "issuance_refused" });
    await expect(mint({ lifetimeSeconds: 0 })).rejects.toMatchObject({
      code: "issuance_refused",
    });
  });
});
