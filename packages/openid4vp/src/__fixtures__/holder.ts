/**
 * A wallet, for tests only.
 *
 * Every adversarial test in this package needs a *valid* presentation to
 * attack, and a valid presentation cannot be a checked-in string: it contains
 * a signature over a nonce this run generated. So the tests mint real
 * credentials with real keys, in process, and then break them one field at a
 * time. Nothing here talks to a network, reads a file, or holds a fixed key.
 *
 * The minting code is deliberately independent of `src/sd-jwt.ts`. If the
 * fixture reused the verifier's own digest routine, a mistake in that routine
 * would cancel out — issuance and verification would agree on the wrong thing
 * and every test would pass. Here the disclosure digest is computed directly
 * from `node:crypto`, so the two implementations must agree on the *format*,
 * not merely on each other.
 *
 * This file is not exported from the package index and must never be imported
 * by production code: it signs credentials, which is the one capability a
 * verifier must not have.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { JsonObject, MutableJsonObject } from "@opensesame/os-domain";
import {
  type CryptoKey,
  type JWK,
  SignJWT,
  exportJWK,
  generateKeyPair,
} from "jose";
import type { SupportedSignatureAlgorithm } from "../jose.js";

function base64urlText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function sha256Base64url(text: string): string {
  return createHash("sha256")
    .update(Buffer.from(text, "utf8"))
    .digest("base64url");
}

/** A key pair plus the public JWK a relying party would be configured with. */
export interface TestKeyPair {
  readonly alg: SupportedSignatureAlgorithm;
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

export async function createTestKeyPair(
  alg: SupportedSignatureAlgorithm = "ES256",
  kid = `k_${randomBytes(6).toString("hex")}`,
): Promise<TestKeyPair> {
  const generated = await generateKeyPair(alg === "EdDSA" ? "Ed25519" : alg, {
    extractable: true,
  });
  const publicJwk = await exportJWK(generated.publicKey);
  return {
    alg,
    kid,
    privateKey: generated.privateKey,
    // `alg` and `kid` on the published key are what lets the verifier pin an
    // algorithm to a key rather than to a token header.
    publicJwk: { ...publicJwk, alg, kid },
  };
}

export interface IssueCredentialInput {
  readonly issuerKey: TestKeyPair;
  readonly issuer: string;
  readonly holderPublicJwk: JWK;
  readonly vct: string;
  /** Claims hidden behind digests; the holder chooses which to reveal. */
  readonly selectivelyDisclosable?: JsonObject | undefined;
  /** Claims the issuer publishes in the clear. */
  readonly plaintext?: JsonObject | undefined;
  readonly issuedAt?: Date | undefined;
  readonly expiresAt?: Date | undefined;
  readonly notBefore?: Date | undefined;
  /** Override the `typ` header — used to test format refusal. */
  readonly typ?: string | undefined;
  /**
   * Claims written into the payload verbatim, after every derived one.
   *
   * The escape hatch for values a `Date` cannot express. A malformed `nbf` is
   * a number, not a moment, so `notBefore` cannot produce one — and the whole
   * point of the tests that use this is that a number outside `Date`'s range
   * used to sail through the validity checks. Deliberately last, so a test can
   * replace `iat`/`exp`/`nbf` rather than only add to them.
   */
  readonly rawClaims?: JsonObject | undefined;
}

export interface IssuedCredential {
  /** The issuer-signed JWT, compact. */
  readonly issuerJwt: string;
  /** Disclosure strings, in issuance order. */
  readonly disclosures: readonly string[];
}

/**
 * Mint an SD-JWT VC.
 *
 * Salts are 16 random bytes — RFC 9901 §9.3 asks for at least 128 bits of
 * entropy so a verifier cannot brute-force an undisclosed claim's value out of
 * its digest.
 */
export async function issueCredential(
  input: IssueCredentialInput,
): Promise<IssuedCredential> {
  const disclosures: string[] = [];
  const digests: string[] = [];
  const hidden = input.selectivelyDisclosable ?? {};
  for (const name of Object.keys(hidden)) {
    const value = hidden[name] ?? null;
    const salt = randomBytes(16).toString("base64url");
    const disclosure = base64urlText(JSON.stringify([salt, name, value]));
    disclosures.push(disclosure);
    digests.push(sha256Base64url(disclosure));
  }

  const payload: MutableJsonObject = {
    iss: input.issuer,
    vct: input.vct,
    cnf: { jwk: jwkToJson(input.holderPublicJwk) },
    _sd: digests,
    _sd_alg: "sha-256",
  };
  const plaintext = input.plaintext ?? {};
  for (const name of Object.keys(plaintext)) {
    payload[name] = plaintext[name] ?? null;
  }
  payload.iat = Math.floor((input.issuedAt ?? new Date()).getTime() / 1000);
  if (input.expiresAt !== undefined) {
    payload.exp = Math.floor(input.expiresAt.getTime() / 1000);
  }
  if (input.notBefore !== undefined) {
    payload.nbf = Math.floor(input.notBefore.getTime() / 1000);
  }
  const raw = input.rawClaims ?? {};
  for (const name of Object.keys(raw)) {
    payload[name] = raw[name] ?? null;
  }

  const issuerJwt = await new SignJWT(payload)
    .setProtectedHeader({
      alg: input.issuerKey.alg,
      typ: input.typ ?? "dc+sd-jwt",
      kid: input.issuerKey.kid,
    })
    .sign(input.issuerKey.privateKey);

  return { issuerJwt, disclosures };
}

/** `<issuer JWT>~<D.1>~...~<D.N>~` — an SD-JWT with no key binding. */
export function serializeSdJwt(
  credential: IssuedCredential,
  selected: readonly string[] = credential.disclosures,
): string {
  return `${[credential.issuerJwt, ...selected].join("~")}~`;
}

export interface PresentInput {
  readonly credential: IssuedCredential;
  readonly holderKey: TestKeyPair;
  /** Defaults to every disclosure the credential carries. */
  readonly selected?: readonly string[] | undefined;
  readonly audience: string;
  readonly nonce: string;
  readonly issuedAt?: Date | undefined;
  /**
   * A raw `iat`, overriding {@link issuedAt}.
   *
   * Same reason as `rawClaims`: the KB-JWT freshness window is defended
   * against numbers, and the interesting ones are not dates.
   */
  readonly issuedAtSeconds?: number | undefined;
  readonly transactionDataHashes?: readonly string[] | undefined;
  readonly transactionDataHashesAlg?: string | undefined;
  /** Sign the KB-JWT with a different key — the holder-binding attack. */
  readonly signingKey?: TestKeyPair | undefined;
  /** Override `sd_hash` — used to test the SD-JWT/KB-JWT tie. */
  readonly sdHash?: string | undefined;
  readonly typ?: string | undefined;
}

/** Produce an SD-JWT+KB the way a conforming wallet would. */
export async function present(input: PresentInput): Promise<string> {
  const selected = input.selected ?? input.credential.disclosures;
  const sdJwt = serializeSdJwt(input.credential, selected);
  const signer = input.signingKey ?? input.holderKey;

  const payload: MutableJsonObject = {
    iat:
      input.issuedAtSeconds ??
      Math.floor((input.issuedAt ?? new Date()).getTime() / 1000),
    aud: input.audience,
    nonce: input.nonce,
    sd_hash: input.sdHash ?? sha256Base64url(sdJwt),
  };
  if (input.transactionDataHashes !== undefined) {
    payload.transaction_data_hashes = [...input.transactionDataHashes];
  }
  if (input.transactionDataHashesAlg !== undefined) {
    payload.transaction_data_hashes_alg = input.transactionDataHashesAlg;
  }

  const keyBindingJwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: signer.alg, typ: input.typ ?? "kb+jwt" })
    .sign(signer.privateKey);

  return `${sdJwt}${keyBindingJwt}`;
}

/**
 * An unsecured JWT (RFC 7519 §6): three segments, the third empty.
 *
 * Syntactically a JWT, semantically "trust me". Used to prove the verifier
 * refuses it on the signature segment and on `alg` independently.
 */
export function unsecuredJwt(header: JsonObject, payload: JsonObject): string {
  return `${base64urlText(JSON.stringify(header))}.${base64urlText(
    JSON.stringify(payload),
  )}.`;
}

/**
 * A genuinely HMAC-signed JWT keyed with an asymmetric *public* key.
 *
 * The classic algorithm-confusion forgery: the attacker knows the public key,
 * so if the verifier lets the token choose `HS256` the attacker can produce a
 * MAC the verifier will accept. The MAC here is real, so the test fails for
 * the right reason — the verifier refusing the algorithm — rather than because
 * the signature bytes happened to be garbage.
 */
export function hmacJwt(
  header: JsonObject,
  payload: JsonObject,
  publicJwk: JWK,
): string {
  const signingInput = `${base64urlText(JSON.stringify(header))}.${base64urlText(
    JSON.stringify(payload),
  )}`;
  const secret = Buffer.from(JSON.stringify(publicJwk), "utf8");
  const signature = createHmac("sha256", secret)
    .update(signingInput, "utf8")
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

/** Re-sign an SD-JWT+KB's KB-JWT segment with arbitrary bytes replaced. */
export function replaceKeyBindingJwt(
  presentation: string,
  replacement: string,
): string {
  const parts = presentation.split("~");
  parts[parts.length - 1] = replacement;
  return parts.join("~");
}

/**
 * The public members of a JWK, copied one at a time.
 *
 * A spread would carry `d` into `cnf` for a key pair generated with
 * `extractable: true`, which is exactly the private-component smuggling the
 * verifier refuses — the fixture must not be the thing that produces it.
 */
function jwkToJson(jwk: JWK): JsonObject {
  const out: MutableJsonObject = {};
  if (jwk.kty !== undefined) out.kty = jwk.kty;
  if (jwk.crv !== undefined) out.crv = jwk.crv;
  if (jwk.x !== undefined) out.x = jwk.x;
  if (jwk.y !== undefined) out.y = jwk.y;
  return out;
}
