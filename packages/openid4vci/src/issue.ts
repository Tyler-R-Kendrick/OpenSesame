/**
 * Minting the OpenSesame credential.
 *
 * **What this credential says, and why it says so little.**
 *
 * It attests one fact: *the holder of this key is associated with this
 * OpenSesame principal (and optionally this device).* Nothing else. The claim
 * set is a pairwise subject reference, an optional device reference, the
 * issuer, `iat`/`exp`, and `cnf.jwk`.
 *
 * It carries no scopes, no roles, no entitlements, no grants, no
 * `authorization_details`, no secret material, and — the one that matters most
 * — no canonical principal id. That is not minimalism for its own sake. A
 * verifiable credential is an offline bearer of whatever it asserts: it is
 * signed once, then presented for as long as it is valid, to parties we never
 * see, with no call back to us. Every authorization fact written into it
 * becomes a fact that cannot be revised, revoked in time, or scoped to the
 * request being made. Put a role in it and you have minted a capability that
 * outlives the decision that granted it.
 *
 * So OpenSesame's runtime authority stays where it can be evaluated against
 * the request in front of it: server-side, behind ConnectionRef and Intent
 * (ADR 0005). This credential is an *identifier*, not an authorization. What
 * it buys is that the identifier is proved by a key the holder controls rather
 * than asserted by whoever is holding a token — and that a verifier who needs
 * only "same subject as last time" never learns the principal id at all.
 *
 * The pairwise reference is the second half of that. The canonical principal
 * id is an OpenSesame-internal join key: it appears in receipts, in policy, in
 * audit. A credential that carries it hands every verifier a durable link into
 * our own namespace and makes two unrelated verifiers able to collude by
 * string equality. {@link deriveSubjectRef} keeps it out by construction — the
 * principal id goes into an HMAC and never comes out.
 *
 * `FORBIDDEN_CREDENTIAL_CLAIMS` is enforced on the production path, against
 * the assembled payload, before signing. Not in a test: a test protects the
 * claim set as it is today, and the check needs to protect it against the
 * change somebody makes next year.
 *
 * **Format.** IETF SD-JWT VC (`dc+sd-jwt`), built by hand on RFC 9901. The
 * selective disclosure is real — per-claim 128-bit salt, SHA-256 digest over
 * the base64url *text* of each disclosure, `~`-joined — because a stub would
 * make `sub` and `iat` unconditionally visible to every verifier, which is the
 * disclosure this design exists to avoid.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  FORBIDDEN_URL_PARAMS,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  hmacDigest,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { CompactSign, type JWK } from "jose";
import { refuse } from "./errors.js";
import { type SupportedAlgorithm, isSupportedAlgorithm } from "./metadata.js";

/**
 * The `typ` of the issuer-signed JWT, and the media type of the whole thing.
 *
 * `dc+sd-jwt` — "dc" for digital credential — replaced `vc+sd-jwt` in
 * November 2024 to stop colliding with the W3C `vc` media type registration.
 * This package emits only the current spelling. Verifiers are advised by
 * draft-ietf-oauth-sd-jwt-vc-18 §2.2.1 to accept both during the transition,
 * and `@opensesame/openid4vp` does; an *issuer* that emits both would just
 * extend the transition. The media type is that revision's §2.1.
 */
export const SD_JWT_VC_TYP = "dc+sd-jwt";
export const SD_JWT_VC_MEDIA_TYPE = "application/dc+sd-jwt";

/**
 * The hash for disclosure digests (RFC 9901 §4.1.1).
 *
 * Written explicitly into `_sd_alg` rather than relying on the default. The
 * default exists for terseness, and a verifier that has to *infer* our hash
 * from its absence is a verifier that has to have a default, which is a
 * downgrade lever pointed at a field we could simply state.
 */
export const SD_ALG = "sha-256";

/** RFC 9901 §9.3 recommends 128 bits of salt entropy per disclosure. */
const SALT_BYTES = 16;

/**
 * Claim names this credential must never carry, beyond the shared URL list.
 *
 * `FORBIDDEN_URL_PARAMS` from `os-domain` already denies the credential-
 * material names (`access_token`, `secret`, `credential`, `assertion`, …) and
 * is reused rather than restated, so the answer to "is this name a bearer" is
 * decided in one place for links and credentials alike. What that list does
 * not cover is the *authorization* vocabulary, which is the specific thing
 * this credential must not contain, so it is enumerated here.
 */
export const FORBIDDEN_CREDENTIAL_CLAIMS: readonly string[] = [
  "scope",
  "scopes",
  "scp",
  "role",
  "roles",
  "entitlement",
  "entitlements",
  "permission",
  "permissions",
  "grant",
  "grants",
  "authorization_details",
  "capabilities",
  "groups",
  "policy",
  "acl",
  "admin",
  "is_admin",
  "act",
  "may_act",
  "azp",
  "client_id",
  "principal",
  "principal_id",
];

declare const PAIRWISE_BRAND: unique symbol;

/**
 * A reference that is opaque by construction.
 *
 * Branded so that a raw `string` cannot be passed where a derived reference is
 * required. The brand is a compile-time guard and a cast defeats it, which is
 * why {@link assertPairwiseRef} re-checks the shape at mint time: a cast can
 * produce a value of this type, but it cannot produce one that looks like the
 * output of an HMAC without doing the work.
 */
export type PairwiseRef<Kind extends string> = string & {
  readonly [PAIRWISE_BRAND]: Kind;
};

export type SubjectRef = PairwiseRef<"subject">;
export type DeviceRef = PairwiseRef<"device">;

const SUBJECT_REF_PURPOSE = "opensesame:openid4vci:subject-ref:v1";
const DEVICE_REF_PURPOSE = "opensesame:openid4vci:device-ref:v1";
const SUBJECT_PREFIX = "sub_";
const DEVICE_PREFIX = "dev_";
/** base64url of a 32-byte HMAC-SHA-256 digest, unpadded. */
const REF_BODY = /^[A-Za-z0-9_-]{43}$/;

export interface PairwiseRefInput {
  /**
   * The value being hidden — a canonical principal id or a device id.
   *
   * It is HMAC input and nothing else. It is not stored, not returned, and not
   * recoverable from the result.
   */
  readonly id: string;
  /**
   * The scope the reference is pairwise *within*.
   *
   * Usually the Credential Issuer Identifier, which gives one stable
   * reference per subject per issuer. That stability is a deliberate
   * trade-off and worth naming: a reference that is constant across every
   * credential we issue to a subject is also a correlator that two colluding
   * verifiers can join on. A deployment that needs unlinkability between
   * presentations passes a per-credential salt here instead and accepts that
   * it can no longer recognise a returning subject. There is no default that
   * makes both true, so the caller chooses.
   */
  readonly audience: string;
  /** Secret. Without it the reference is a dictionary attack on the id space. */
  readonly pepper: Uint8Array | string;
}

function derive(
  purpose: string,
  prefix: string,
  input: PairwiseRefInput,
): string {
  if (input.id.length === 0 || input.audience.length === 0) {
    refuse("subject_reference_invalid");
  }
  if (input.pepper.length === 0) refuse("subject_reference_invalid");
  // `hmacDigest` is `os-domain`'s length-prefixed, domain-separated HMAC. The
  // length prefixes are why `audience` and `id` cannot be slid across their
  // boundary to produce one digest from two different pairs.
  const digest = hmacDigest(input.pepper, purpose, input.audience, input.id);
  return `${prefix}${Buffer.from(digest).toString("base64url")}`;
}

export function deriveSubjectRef(input: PairwiseRefInput): SubjectRef {
  const reference = derive(SUBJECT_REF_PURPOSE, SUBJECT_PREFIX, input);
  assertPairwiseRef(reference, SUBJECT_PREFIX);
  // The brand names exactly what the line above requires: the `sub_` prefix
  // and 43 base64url characters of HMAC output, and nothing else.
  // That invariant is re-applied by `issueCredential` at mint time.
  // SAFETY: the shape the brand names is checked on the line above.
  return reference as SubjectRef;
}

export function deriveDeviceRef(input: PairwiseRefInput): DeviceRef {
  const reference = derive(DEVICE_REF_PURPOSE, DEVICE_PREFIX, input);
  assertPairwiseRef(reference, DEVICE_PREFIX);
  // SAFETY: the `dev_` invariant is checked on the line above, as for subjects.
  return reference as DeviceRef;
}

/** Shape check that survives a cast. See {@link PairwiseRef}. */
function assertPairwiseRef(value: string, prefix: string): void {
  if (!value.startsWith(prefix)) refuse("subject_reference_invalid");
  if (!REF_BODY.test(value.slice(prefix.length)))
    refuse("subject_reference_invalid");
}

export interface IssueCredentialInput {
  /** Goes into `iss`. Must be the Credential Issuer Identifier. */
  readonly credentialIssuer: string;
  /** Goes into `vct`. Must match the advertised configuration. */
  readonly vct: string;
  readonly subject: SubjectRef;
  readonly device?: DeviceRef;
  /** The key from {@link verifyProofOfPossession}. Becomes `cnf.jwk`. */
  readonly holderJwk: JWK;
  /** The issuer's private key, in any form `jose` accepts. */
  readonly signingKey: CryptoKey | Uint8Array;
  readonly signingAlgorithm: SupportedAlgorithm;
  /** Identifies the issuer key in a JWKS, for rotation. */
  readonly signingKeyId?: string;
  readonly lifetimeSeconds: number;
  readonly now?: Date;
}

export interface IssuedDisclosure {
  readonly claimName: string;
  /** The base64url text. The digest is over these bytes, not their content. */
  readonly encoded: string;
  readonly digest: string;
}

export interface IssuedCredential {
  /** `<issuer-signed JWT>~<D.1>~…~<D.N>~`, ready to hand to a wallet. */
  readonly credential: string;
  /** The issuer-signed JWT alone. */
  readonly issuerJwt: string;
  readonly disclosures: readonly IssuedDisclosure[];
  readonly mediaType: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/**
 * One disclosure: `[salt, name, value]`, base64url of its UTF-8 JSON.
 *
 * The digest is taken over the base64url *string*, not over the bytes it
 * encodes (RFC 9901 §4.2.3). Hashing the decoded JSON would still be a
 * self-consistent scheme — it just would not be this one, and no verifier
 * would agree with us. The consequence is that our exact `JSON.stringify`
 * output, whitespace and escaping included, is what the signature covers.
 */
function makeDisclosure(name: string, value: JsonValue): IssuedDisclosure {
  const salt = base64url(randomBytes(SALT_BYTES));
  const encoded = Buffer.from(
    JSON.stringify([salt, name, value]),
    "utf8",
  ).toString("base64url");
  const digest = base64url(
    createHash("sha256").update(Buffer.from(encoded, "ascii")).digest(),
  );
  return { claimName: name, encoded, digest };
}

/**
 * The holder key, re-validated at the boundary.
 *
 * `verifyProofOfPossession` already rebuilds the key from a fixed member list,
 * but `issueCredential` is a public function and someone will eventually call
 * it with a JWK from somewhere else. Whatever lands in `cnf.jwk` is signed by
 * us, so the member list is enforced here too rather than assumed.
 */
function checkedHolderJwk(jwk: JWK): JsonObject {
  // `jose`'s `JWK` is an open interface with an `unknown` index signature, so
  // this only re-describes the same object with a value type a guard can read.
  // Nothing is read between the two lines, and every member used afterwards is
  // re-checked with `isString` before it is copied into the result.
  // SAFETY: `isJsonObject` on the next line is the checked contract boundary.
  const source = jwk as JsonObject;
  if (!isJsonObject(source)) refuse("issuance_refused");
  const kty = source.kty;
  const crv = source.crv;
  const x = source.x;
  if (!isString(kty) || !isString(crv) || !isString(x))
    refuse("issuance_refused");
  for (const member of ["d", "k", "p", "q", "dp", "dq", "qi"]) {
    if (source[member] !== undefined) refuse("issuance_refused");
  }
  if (kty === "EC") {
    const y = source.y;
    if (!isString(y)) refuse("issuance_refused");
    return { kty, crv, x, y };
  }
  if (kty === "OKP") return { kty, crv, x };
  refuse("issuance_refused");
}

/**
 * Refuse any claim name this credential must not carry.
 *
 * Applied to the plaintext payload *and* to every disclosure name, because a
 * selectively disclosable entitlement is still an entitlement — it is merely
 * one the holder gets to choose when to spend.
 */
function assertNoForbiddenClaims(names: readonly string[]): void {
  for (const name of names) {
    const lowered = name.toLowerCase();
    if (FORBIDDEN_CREDENTIAL_CLAIMS.includes(lowered)) {
      refuse("forbidden_credential_claim");
    }
    if (FORBIDDEN_URL_PARAMS.includes(lowered)) {
      refuse("forbidden_credential_claim");
    }
  }
}

/**
 * Mint one SD-JWT VC.
 *
 * The split between plaintext and selectively disclosable claims is the
 * design, not a tuning knob:
 *
 * - **`iss`, `vct`, `cnf`, `exp` are plaintext.** SD-JWT VC §2.2.2.3 forbids
 *   putting `iss`, `vct` or `cnf` in disclosures at all, and rightly: a
 *   verifier cannot choose a signature key, a schema, or a holder-binding key
 *   it has not been given. `exp` joins them because a verifier must be able to
 *   reject an expired credential without the holder's cooperation.
 * - **`sub`, `device_ref` and `iat` are selectively disclosable.** A verifier
 *   that only needs "a live OpenSesame holder" gets exactly that and learns
 *   neither which subject nor which device nor when we issued it. §2.2.2.3
 *   explicitly permits `sub` and `iat` in disclosures.
 * - **`nbf` is absent.** It would be `iat` in the clear under another name,
 *   and would undo the reason `iat` is disclosable at all.
 *
 * One residual is worth stating rather than hiding: `exp` is public, so a
 * verifier who knows the configured lifetime can compute the issuance time to
 * within nothing. Deployments that care should vary the lifetime; this
 * function will not do it silently, because a jittered `exp` that the operator
 * did not ask for is a surprise in an audit trail.
 */
export async function issueCredential(
  input: IssueCredentialInput,
): Promise<IssuedCredential> {
  if (!isSupportedAlgorithm(input.signingAlgorithm)) refuse("issuance_refused");
  if (input.credentialIssuer.length === 0 || input.vct.length === 0) {
    refuse("issuance_refused");
  }
  const lifetime = input.lifetimeSeconds;
  if (!Number.isFinite(lifetime) || lifetime <= 0) refuse("issuance_refused");

  assertPairwiseRef(input.subject, SUBJECT_PREFIX);
  if (input.device !== undefined)
    assertPairwiseRef(input.device, DEVICE_PREFIX);

  const holderJwk = checkedHolderJwk(input.holderJwk);
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const expiresAt = issuedAt + Math.floor(lifetime);

  const disclosures: IssuedDisclosure[] = [
    makeDisclosure("sub", input.subject),
    makeDisclosure("iat", issuedAt),
  ];
  if (input.device !== undefined) {
    disclosures.push(makeDisclosure("device_ref", input.device));
  }

  const payload: MutableJsonObject = {
    iss: input.credentialIssuer,
    vct: input.vct,
    exp: expiresAt,
    cnf: { jwk: holderJwk },
    _sd_alg: SD_ALG,
    // Sorted, which satisfies RFC 9901 §4.2.4.1's requirement to hide the
    // original claim order: the array position of a digest must not tell a
    // verifier which claim it belongs to.
    _sd: disclosures.map((disclosure) => disclosure.digest).sort(),
  };

  // The last gate before a signature. Covers both halves of the claim set, so
  // a future edit that adds `scope` to either one throws here rather than
  // shipping a signed entitlement. `_sd`/`_sd_alg`/`cnf` are structural and
  // are checked along with everything else — none of them is a forbidden name,
  // and hard-coding an exemption is how exemptions grow.
  assertNoForbiddenClaims([
    ...Object.keys(payload),
    ...disclosures.map((disclosure) => disclosure.claimName),
  ]);

  const baseHeader = { alg: input.signingAlgorithm, typ: SD_JWT_VC_TYP };
  const protectedHeader =
    input.signingKeyId === undefined
      ? baseHeader
      : { ...baseHeader, kid: input.signingKeyId };

  const issuerJwt = await new CompactSign(
    new TextEncoder().encode(JSON.stringify(payload)),
  )
    .setProtectedHeader(protectedHeader)
    .sign(input.signingKey);

  // RFC 9901 §4: the trailing `~` is mandatory and is what tells a verifier
  // that no Key Binding JWT is attached. An issuer never attaches one — key
  // binding is proved at presentation time, by the holder, to the verifier.
  const credential = `${[issuerJwt, ...disclosures.map((d) => d.encoded)].join("~")}~`;

  return {
    credential,
    issuerJwt,
    disclosures,
    mediaType: SD_JWT_VC_MEDIA_TYPE,
    issuedAt,
    expiresAt,
  };
}
