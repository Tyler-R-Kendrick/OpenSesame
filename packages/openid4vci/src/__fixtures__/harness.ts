/**
 * Test harness: real keys, hand-built tokens, and a verifier-side resolver.
 *
 * Three rules shape this file.
 *
 * **Nothing is mocked.** Every key is generated in-process, every signature is
 * a real one, and the round-trip test drives the same functions a gateway
 * would. An issuance test that stubs the signature proves that the plumbing
 * type-checks and nothing else.
 *
 * **Tokens are assembled by hand.** The adversarial tests need a proof with
 * `alg: none`, a proof naming a `crit` extension, a proof whose header carries
 * two key references — all things a correct JWS builder makes impossible.
 * `jose` refuses to produce them, correctly, which is why {@link signCompact}
 * signs with WebCrypto over the exact header bytes it is handed instead.
 * An attacker has no library validating its output either.
 *
 * **The resolver is deliberately independent.** {@link resolveDisclosures} is
 * the minimum RFC 9901 §7.3 reader needed to prove that what this issuer emits
 * can be read back. It computes digests straight from `node:crypto` rather
 * than reusing anything in `issue.ts`, so agreement between them is agreement
 * about the format rather than a shared mistake. It lives here rather than in
 * the package because resolving disclosures is a verifier's job.
 */

import { createHash } from "node:crypto";
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type JWK, exportJWK, generateKeyPair } from "jose";
import { Openid4vciError } from "../errors.js";
import type { SupportedAlgorithm } from "../metadata.js";

export interface TestKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

export async function generateTestKeyPair(
  algorithm: SupportedAlgorithm,
): Promise<TestKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(algorithm, {
    extractable: true,
  });
  return { privateKey, publicJwk: await exportJWK(publicKey) };
}

/** An HMAC key over arbitrary bytes, for the algorithm-confusion test. */
export async function importHmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function encodeSegment(value: JsonObject): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * The WebCrypto parameters for a JOSE `alg`, including the ones we refuse.
 *
 * `HS256` is here on purpose: the confusion test needs a *genuine* MAC, so
 * that the proof is refused because the algorithm is not allowed rather than
 * because the signature bytes happened to be garbage.
 */
function signingParameters(
  algorithm: string,
): AlgorithmIdentifier | EcdsaParams {
  if (algorithm === "ES256") return { name: "ECDSA", hash: "SHA-256" };
  if (algorithm === "EdDSA") return { name: "Ed25519" };
  if (algorithm === "HS256") return { name: "HMAC" };
  throw new Error(`the harness cannot sign ${algorithm}`);
}

/**
 * Sign an arbitrary protected header over an arbitrary payload.
 *
 * The header is serialized exactly as given — no field is added, removed, or
 * validated — and WebCrypto's ECDSA output is already the raw `r||s` JWS
 * expects, so no re-encoding stands between the bytes signed and the bytes
 * sent. `alg: none` has no signing parameters and is built by
 * {@link unsecuredCompact} instead.
 */
export async function signCompact(
  header: JsonObject,
  payload: JsonObject,
  key: CryptoKey,
): Promise<string> {
  const algorithm = header.alg;
  if (!isString(algorithm)) throw new Error("header has no alg");
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    signingParameters(algorithm),
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

/**
 * An RFC 7519 §6 unsecured JWT: three segments, the last one empty.
 *
 * Syntactically a JWT, semantically "trust me". A test that cannot build one
 * cannot prove that the shape is refused.
 */
export function unsecuredCompact(
  header: JsonObject,
  payload: JsonObject,
): string {
  return `${encodeSegment(header)}.${encodeSegment(payload)}.`;
}

/**
 * A `JWK` as plain JSON, for embedding in a header a test builds by hand.
 *
 * One place for the assertion rather than one per adversarial test: `jose`'s
 * `JWK` is an open interface with an `unknown` index signature, and every key
 * in this harness came out of `exportJWK`.
 */
export function jwkJson(jwk: JWK): JsonObject {
  // SAFETY: `exportJWK` produced this object, so it is already JSON.
  return jwk as JsonObject;
}

/** The canonical header a well-behaved wallet sends. */
export function proofHeader(
  algorithm: SupportedAlgorithm,
  jwk: JWK,
): JsonObject {
  return {
    alg: algorithm,
    typ: "openid4vci-proof+jwt",
    jwk: jwkJson(jwk),
  };
}

export function proofPayload(
  audience: string,
  nonce: string,
  issuedAt: number,
): JsonObject {
  return { aud: audience, iat: issuedAt, nonce };
}

function decodeSegment(
  compact: string,
  index: number,
  what: string,
): JsonObject {
  const segment = compact.split(".")[index];
  if (segment === undefined) throw new Error("not a compact JWS");
  const parsed: JsonValue = JSON.parse(
    Buffer.from(segment, "base64url").toString("utf8"),
  );
  if (!isJsonObject(parsed)) throw new Error(`${what} is not an object`);
  return parsed;
}

/** Read a compact JWS payload without verifying anything. Tests only. */
export function decodePayload(compact: string): JsonObject {
  return decodeSegment(compact, 1, "payload");
}

export function decodeHeader(compact: string): JsonObject {
  return decodeSegment(compact, 0, "header");
}

export interface ResolvedCredential {
  readonly claims: JsonObject;
  readonly disclosedNames: readonly string[];
}

/**
 * The verifier half of selective disclosure, minimally.
 *
 * Enforces the three rules that make the mechanism mean anything (RFC 9901
 * §7.3): every presented disclosure must match a digest in `_sd`, a digest may
 * be consumed only once, and a disclosed name may not overwrite a claim the
 * issuer put in plaintext. A resolver that skips any of them would accept the
 * tampered disclosure the tests hand it.
 */
export function resolveDisclosures(credential: string): ResolvedCredential {
  const parts = credential.split("~");
  const issuerJwt = parts.at(0);
  if (issuerJwt === undefined) throw new Error("not an SD-JWT");
  if (parts.at(-1) !== "") throw new Error("missing trailing tilde");
  const encodedDisclosures = parts.slice(1, parts.length - 1);

  const payload = decodePayload(issuerJwt);
  const sd = payload._sd;
  const digests = new Set<string>(
    Array.isArray(sd) ? sd.filter((value) => isString(value)) : [],
  );

  const claims: JsonObject = {};
  for (const [name, value] of Object.entries(payload)) {
    if (name === "_sd" || name === "_sd_alg") continue;
    claims[name] = value;
  }

  const disclosedNames: string[] = [];
  for (const encoded of encodedDisclosures) {
    const digest = createHash("sha256")
      .update(Buffer.from(encoded, "ascii"))
      .digest("base64url");
    if (!digests.has(digest)) throw new Error("disclosure digest not found");
    digests.delete(digest);
    const [, name, value] = readDisclosure(encoded);
    if (Object.hasOwn(claims, name)) {
      throw new Error("disclosure overwrites a claim");
    }
    claims[name] = value;
    disclosedNames.push(name);
  }

  return { claims, disclosedNames };
}

/** Re-encode a disclosure with its value replaced, salt and name intact. */
export function tamperDisclosure(encoded: string): string {
  const [salt, name] = readDisclosure(encoded);
  return Buffer.from(JSON.stringify([salt, name, "tampered"]), "utf8").toString(
    "base64url",
  );
}

/**
 * Run something that must refuse, and hand back the refusal.
 *
 * Generic over the runner's return type so the helper never has to name
 * `unknown`, and it re-throws anything that is not ours: a `TypeError` from a
 * typo in a test would otherwise be silently accepted as "it refused".
 */
export function refusalOf<T>(run: () => T): Openid4vciError {
  try {
    run();
  } catch (thrown) {
    if (thrown instanceof Openid4vciError) return thrown;
    throw thrown;
  }
  throw new Error("expected a refusal, but the call returned");
}

/** {@link refusalOf} for a promise-returning body. */
export async function asyncRefusalOf<T>(
  run: () => Promise<T>,
): Promise<Openid4vciError> {
  try {
    await run();
  } catch (thrown) {
    if (thrown instanceof Openid4vciError) return thrown;
    throw thrown;
  }
  throw new Error("expected a refusal, but the call resolved");
}

/**
 * Readers for the JSON documents this package emits.
 *
 * Tests assert on `credential_configurations_supported` and on offer grants,
 * both of which are nested JSON. Reading them through guards rather than casts
 * means a shape regression fails as a clear "no configuration X" rather than
 * as an undefined-property comparison three assertions later.
 */
export function credentialConfigurationIds(
  metadata: JsonObject,
): readonly string[] {
  const configurations = metadata.credential_configurations_supported;
  if (!isJsonObject(configurations)) {
    throw new Error("metadata has no credential_configurations_supported");
  }
  return Object.keys(configurations);
}

export function credentialConfiguration(
  metadata: JsonObject,
  id: string,
): JsonObject {
  const configurations = metadata.credential_configurations_supported;
  if (!isJsonObject(configurations)) {
    throw new Error("metadata has no credential_configurations_supported");
  }
  const entry = configurations[id];
  if (!isJsonObject(entry)) {
    throw new Error(`metadata has no configuration ${id}`);
  }
  return entry;
}

/** The parameters of an offer's pre-authorized code grant. */
export function preAuthorizedGrantParameters(offer: JsonObject): JsonObject {
  const grants = offer.grants;
  if (!isJsonObject(grants)) throw new Error("offer has no grants");
  const parameters =
    grants["urn:ietf:params:oauth:grant-type:pre-authorized_code"];
  if (!isJsonObject(parameters)) {
    throw new Error("offer has no pre-authorized code grant");
  }
  return parameters;
}

/** A string member, or a test failure naming the member. */
export function readString(object: JsonObject, key: string): string {
  const value = object[key];
  if (!isString(value)) throw new Error(`${key} is not a string`);
  return value;
}

/** A string array member, or a test failure naming the member. */
export function readStringArray(
  object: JsonObject,
  key: string,
): readonly string[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new Error(`${key} is not an array`);
  return value.map((entry, index) => {
    if (!isString(entry)) throw new Error(`${key}[${index}] is not a string`);
    return entry;
  });
}

/** The `[salt, name, value]` triple a disclosure encodes. */
export function readDisclosure(
  encoded: string,
): readonly [string, string, JsonValue] {
  const parsed: JsonValue = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  );
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error("disclosure is not [salt, name, value]");
  }
  const [salt, name, value] = parsed;
  if (!isString(salt) || !isString(name)) {
    throw new Error("disclosure salt or name is not a string");
  }
  return [salt, name, value ?? null];
}
