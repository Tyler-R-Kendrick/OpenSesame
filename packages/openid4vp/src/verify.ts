/**
 * The load-bearing file: turning a POST body into a fact.
 *
 * `verifyPresentation` reduces an OpenID4VP Authorization Response to a
 * `VerifiedPresentation` — a small record of *what was proven* — or throws an
 * `Openid4vpError` naming which check refused it. There is no third outcome
 * and no partial result, because a caller holding "the signature verified but
 * the nonce did not" will eventually use it.
 *
 * ## What survives verification
 *
 * Nothing that could be replayed. The VP token, the issuer-signed JWT, the
 * disclosures, the KB-JWT, the holder's public key: all of it is consumed here
 * and none of it is in the return value. What comes out is a subject handle, a
 * credential handle, the request digest the presentation was bound to, a
 * description of the assurance, and the disclosed claims. A caller cannot
 * accidentally forward a `VerifiedPresentation` to another verifier and have
 * it accepted, because there is nothing in it to accept.
 *
 * ## Order, and why it is not quite the obvious one
 *
 * Session, response mode, and the request-digest cross-check come first: they
 * are constant-time-ish rejections that do not touch a key, and they discard
 * the entire class of responses aimed at the wrong session before any
 * expensive parsing.
 *
 * Nonce and audience *cannot* come before parsing, because they live inside
 * the KB-JWT. They are therefore checked twice: once immediately after the
 * JOSE header policy, as a cheap refusal on unauthenticated claims, and again
 * after the KB-JWT signature verifies. The second check is the security-
 * bearing one — comparing a claim nobody has authenticated proves nothing, and
 * the only reason the first check exists at all is to avoid doing elliptic
 * curve work for a response that is obviously not ours. Both comparisons are
 * constant time.
 *
 * Consumption is last. A response that fails any check leaves the session
 * open, so a wallet whose first attempt was malformed can retry; a response
 * that passes closes it forever, so one authorization request settles exactly
 * one interaction. Everything the return value reports is therefore read
 * *before* the session is spent — including the timestamps that only decorate
 * the assurance record — so that no refusal can happen after the session has
 * already been closed.
 *
 * ## The input is not trusted either
 *
 * Step 0 re-checks the caller's own arguments before anything else runs.
 * `VerifyPresentationInput` describes what a caller promises; a route handler
 * that forwards a parsed request body promises it on the body's behalf, and
 * the body is written by whoever POSTed. A missing `state` or a `now` that is
 * an Invalid Date must therefore become an `Openid4vpError` like any other
 * refusal, not a `TypeError` from three frames deeper — see `errors.ts` for
 * why a foreign error escaping this package is a defect in its own right.
 */

import {
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { type JWK, calculateJwkThumbprint } from "jose";
import {
  DEFAULT_HASH_ALGORITHM,
  type HashAlgorithm,
  constantTimeEquals,
  decodeBase64url,
  decodeUtf8,
  hashStringToBase64url,
  isHashAlgorithm,
} from "./encoding.js";
import {
  type Openid4vpCheckpoint,
  type Openid4vpErrorCode,
  guarded,
  refuse,
} from "./errors.js";
import {
  type CheckedCompactJws,
  KEY_BINDING_JWT_TYP,
  SD_JWT_VC_TYPS,
  type SupportedSignatureAlgorithm,
  readSignedCompactJws,
  verifyCompactJws,
} from "./jose.js";
import {
  type AuthorizationRequest,
  REQUEST_BINDING_TRANSACTION_DATA_TYPE,
  type VerifiableCredentialFormat,
  isVerifiableCredentialFormat,
  transactionDataHash,
} from "./request.js";
import { parseSdJwt, readDisclosures, resolveDisclosures } from "./sd-jwt.js";
import type { RequestSessionStore } from "./session.js";

/**
 * An issuer this verifier trusts, and the keys it trusts it with.
 *
 * Deliberately a static allow-list rather than a JWKS URL. Resolving issuer
 * keys over the network at verification time makes the response endpoint an
 * SSRF trigger: the `iss` claim is attacker-chosen and the fetch happens
 * before any signature is checked. A deployment that wants rotation should
 * refresh this list on its own schedule, out of band.
 *
 * Each key must be usable for exactly one algorithm, which is the third and
 * strongest pin against algorithm confusion — see `jose.ts`.
 */
export interface TrustedIssuer {
  /** Matched against the credential's `iss` claim, exactly. */
  readonly issuer: string;
  readonly keys: readonly JWK[];
}

/**
 * An Authorization Response as the verifier's endpoint received it.
 *
 * `state` is the wallet-echoed `state` form parameter for `direct_post`. Over
 * the DC API there is no `state` in the response at all (§A.2), so the caller
 * supplies the value from the browser session that made the
 * `navigator.credentials.get()` call — the session it has held all along.
 *
 * `responseMode` is what the *transport* observed, not what the response
 * claims: a form POST to the response URI is `direct_post`, a resolved DC API
 * promise is `dc_api`. Taking it from the message would make the check
 * self-certifying.
 *
 * A type alias rather than an interface, deliberately. Every member of this
 * shape is copied out of an HTTP request body, so `verifyPresentation` re-reads
 * each one through the `os-domain` boundary guards instead of believing the
 * declaration — and only an object *type literal* carries the implicit index
 * signature those guards require. Declaring it as an interface would compile
 * and would quietly make the guards unreachable.
 */
export type PresentationResponse = {
  readonly state: string;
  readonly responseMode: string;
  /** The parsed `vp_token`: DCQL query id → array of presentations (§8.1). */
  readonly vpToken: JsonObject;
};

export interface VerifyPresentationInput {
  readonly response: PresentationResponse;
  readonly store: RequestSessionStore;
  readonly trustedIssuers: readonly TrustedIssuer[];
  /**
   * The request digest the caller believes this response settles.
   *
   * The whole point of the parameter is that it comes from the caller's own
   * state, not from the message, so that "this VP settles interaction X" is
   * checked rather than assumed.
   */
  readonly expectedRequestDigest: string;
  readonly now?: Date | undefined;
  /** Tolerance for `exp`/`nbf`/`iat`. Default 60s. */
  readonly clockSkewSeconds?: number | undefined;
  /** How stale a KB-JWT `iat` may be. Default 300s. */
  readonly keyBindingMaxAgeSeconds?: number | undefined;
  /**
   * Domain separation for both handles in {@link VerifiedPresentation}.
   *
   * Defaults to the request's audience, which makes the subject and credential
   * handles stable within one verifier and uncorrelatable between two — §15.5's
   * verifier-to-verifier unlinkability, enforced on our side rather than
   * assumed of the wallet. Named for the subject handle because that is the one
   * a caller usually reasons about; it scopes the credential handle too, and
   * scoping only one of them would leave the join it prevents wide open.
   */
  readonly subjectScope?: string | undefined;
}

/**
 * What the presentation established, in terms that survive being logged.
 *
 * Not an `AssuranceVector` from the domain package. That type describes what
 * an *authenticator* did — user verification, device binding, key protection,
 * syncability — and none of it is observable from a verifiable presentation.
 * A wallet's KB-JWT proves possession of a key at a moment in time and says
 * nothing about whether a human was asked, or whether the key sits in a
 * Secure Enclave or a JSON file. Filling those fields in would be inventing
 * evidence, so this type states only what was actually checked.
 */
export interface PresentationAssurance {
  readonly format: VerifiableCredentialFormat;
  readonly issuer: string;
  /** How the issuer was trusted. One value today: a configured allow-list. */
  readonly issuerTrust: "configured_allowlist";
  /** The SD-JWT VC type (`vct`). */
  readonly credentialType: string;
  readonly holderBinding: "cryptographic_key_binding";
  readonly credentialAlgorithm: SupportedSignatureAlgorithm;
  readonly keyBindingAlgorithm: SupportedSignatureAlgorithm;
  /** When the holder signed the KB-JWT (its `iat`). */
  readonly keyBoundAt: Date;
  readonly credentialIssuedAt: Date | null;
  readonly credentialNotBefore: Date | null;
  readonly credentialExpiresAt: Date | null;
  /** Transaction-data types the holder's signature covered. */
  readonly transactionDataTypes: readonly string[];
  readonly disclosedClaimNames: readonly string[];
}

export interface VerifiedPresentation {
  /**
   * A handle for the holder key, scoped to this verifier.
   *
   * A salted digest of the RFC 7638 thumbprint, not the thumbprint itself: a
   * bare thumbprint is a global correlator for one holder across every
   * verifier that ever sees the credential.
   */
  readonly subjectRef: string;
  /**
   * A handle for this credential instance, scoped to this verifier.
   *
   * A digest, not the credential — and salted by {@link
   * VerifyPresentationInput.subjectScope} exactly as {@link subjectRef} is. The
   * material underneath is the issuer-signed JWT, which the holder replays
   * byte-for-byte to every verifier it presents to, so an unscoped digest would
   * be the cross-verifier join key this whole return type is shaped to avoid.
   */
  readonly credentialRef: string;
  /** The OpenSesame request digest the holder's signature covered. */
  readonly boundDigest: string;
  readonly assurance: PresentationAssurance;
  readonly verifiedAt: Date;
  /** Disclosed and plaintext claims, with SD machinery and `cnf` removed. */
  readonly claims: JsonObject;
}

const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_KEY_BINDING_MAX_AGE_SECONDS = 300;

/**
 * Field separator inside the strings the returned handles are digests of.
 *
 * A NUL rather than a space, because none of the fields it separates — a
 * purpose string, a verifier scope, a JWK thumbprint, a compact JWS — can
 * contain one, so the concatenation is unambiguous no matter what a caller
 * passes as `subjectScope`. Written as an escape: it was a literal NUL byte in
 * the source until this comment existed, which made the file unreadable to
 * `grep` and the separator invisible to every reviewer. The bytes hashed are
 * unchanged.
 */
const SEPARATOR = "\u0000";

export async function verifyPresentation(
  input: VerifyPresentationInput,
): Promise<VerifiedPresentation> {
  // ---- 0. The caller's own arguments --------------------------------------
  // Cheapest checks in the function and the ones with the least to say for
  // themselves, so they run before any lookup. Each refusal below names the
  // check the bad argument would otherwise have *disabled* rather than a
  // generic "bad input", because that is the fact an operator needs: a
  // `state` that is not a string cannot identify a session, and an absent
  // `expectedRequestDigest` cannot cross-check a request binding.
  const response = input.response;
  if (!isJsonObject(response)) {
    refuse("malformed_presentation", "response_envelope");
  }
  const state = response.state;
  if (!isString(state) || state.length === 0) {
    refuse("state_unknown", "session_lookup");
  }
  const responseMode = response.responseMode;
  if (!isString(responseMode)) {
    refuse("response_mode_mismatch", "response_mode");
  }
  const vpToken = response.vpToken;
  if (!isJsonObject(vpToken)) {
    refuse("malformed_presentation", "vp_token_shape");
  }
  const expectedRequestDigest = input.expectedRequestDigest;
  if (!isString(expectedRequestDigest) || expectedRequestDigest.length === 0) {
    refuse("digest_mismatch", "request_binding");
  }
  if (!Array.isArray(input.trustedIssuers)) {
    refuse("issuer_untrusted", "issuer_signature");
  }
  const subjectScope = input.subjectScope;
  if (subjectScope !== undefined && !isString(subjectScope)) {
    refuse("malformed_presentation", "response_envelope");
  }
  // An Invalid Date is the same defect as the epoch claims below and does more
  // damage: `NaN` propagates through every comparison, and each of `>`, `<` and
  // `<=` is false against it, so a single bad `now` silently switches off
  // request expiry, credential validity *and* key-binding freshness at once.
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    refuse("malformed_presentation", "response_envelope");
  }
  const skewMs = readDurationMs(
    input.clockSkewSeconds,
    DEFAULT_CLOCK_SKEW_SECONDS,
  );
  const maxAgeMs = readDurationMs(
    input.keyBindingMaxAgeSeconds,
    DEFAULT_KEY_BINDING_MAX_AGE_SECONDS,
  );

  // ---- 1. Request session -------------------------------------------------
  const record = await input.store.lookup(state);
  if (record === null) refuse("state_unknown", "session_lookup");
  // A consumed session is kept precisely so this branch can exist: replay of a
  // whole response is a different event from a response to nothing.
  if (record.consumedAt !== null) {
    refuse("presentation_replayed", "session_lookup");
  }
  const request = record.request;
  if (request.expiresAt.getTime() <= now.getTime()) {
    refuse("request_expired", "session_lookup");
  }

  // ---- 2. Response mode ---------------------------------------------------
  // §14.2: `direct_post` and the DC API have materially different session-
  // fixation properties. A response arriving by a mode the request did not ask
  // for is either a misrouted wallet or an attacker moving a response onto a
  // transport with weaker binding, and neither is worth verifying.
  if (responseMode !== request.responseMode) {
    refuse("response_mode_mismatch", "response_mode");
  }

  // ---- 3. Request-digest cross-check (cheap half) -------------------------
  // Cheap because it compares two values we already hold. The cryptographic
  // half — proving the *holder* signed over this digest — is step 10.
  if (!constantTimeEquals(request.requestDigest, expectedRequestDigest)) {
    refuse("digest_mismatch", "request_binding");
  }

  // ---- 4. VP token shape and credential format ----------------------------
  const query = request.dcqlQuery.credentials[0];
  if (query === undefined || request.dcqlQuery.credentials.length !== 1) {
    // See SUPPORT_MATRIX: one Credential Query per request, so that one
    // response yields exactly one VerifiedPresentation and the return type
    // does not have to describe a partial success.
    refuse("query_not_satisfied", "vp_token_shape");
  }
  if (!isVerifiableCredentialFormat(query.format)) {
    // Reached when a session was built by something other than
    // buildAuthorizationRequest. `mso_mdoc` lands here and is refused by name.
    refuse("format_not_supported", "credential_format");
  }
  const tokenKeys = Object.keys(vpToken);
  if (tokenKeys.length !== 1 || tokenKeys[0] !== query.id) {
    // §8.1 keys `vp_token` by DCQL query id. An extra key is a presentation we
    // never asked for; a missing one is no presentation at all.
    refuse("malformed_presentation", "vp_token_shape");
  }
  const entries = vpToken[query.id];
  if (!Array.isArray(entries) || entries.length !== 1) {
    // `multiple` defaults to false (§6.1), so the array holds exactly one.
    refuse("malformed_presentation", "vp_token_shape");
  }
  const presentation = entries[0];
  if (!isString(presentation) || presentation.length === 0) {
    refuse("malformed_presentation", "vp_token_shape");
  }

  // ---- 5. SD-JWT+KB structure ---------------------------------------------
  const parsed = guarded(
    "presentation_structure",
    "malformed_presentation",
    () => parseSdJwt(presentation),
  );
  const keyBindingJwt = parsed.keyBindingJwt;
  if (keyBindingJwt === null) {
    // §B.3 requires an SD-JWT+KB whenever cryptographic holder binding is
    // required, and this verifier always requires it. A bare SD-JWT is a
    // credential anyone who has seen it once can present.
    refuse("holder_binding_failed", "key_binding");
  }

  // ---- 6. JOSE header policy on both JWTs ---------------------------------
  const issuerJws = readSignedCompactJws(parsed.issuerJwt, null, "jose_header");
  if (issuerJws.typ === null || !SD_JWT_VC_TYPS.includes(issuerJws.typ)) {
    // The credential names its own format in `typ` (media type
    // `application/dc+sd-jwt`). Anything else — an mdoc wrapper, a
    // `jwt_vc_json` VP, an untyped JWT — is refused by name here.
    refuse("format_not_supported", "credential_format");
  }
  const keyBindingJws = readSignedCompactJws(
    keyBindingJwt,
    [KEY_BINDING_JWT_TYP],
    "jose_header",
  );

  // ---- 7. Nonce and audience, first pass ----------------------------------
  // Unauthenticated at this point. Re-checked in step 9 over the same object
  // once its signature has verified; that is the check that counts.
  const claimedNonce = keyBindingJws.payload.nonce;
  if (
    !isString(claimedNonce) ||
    !constantTimeEquals(claimedNonce, request.nonce)
  ) {
    refuse("nonce_mismatch", "nonce_binding");
  }
  const claimedAudience = keyBindingJws.payload.aud;
  if (
    !isString(claimedAudience) ||
    !constantTimeEquals(claimedAudience, request.audience)
  ) {
    refuse("audience_mismatch", "audience_binding");
  }

  // ---- 8. Issuer signature and credential validity ------------------------
  const issuerPayload = issuerJws.payload;
  const issuer = issuerPayload.iss;
  if (!isString(issuer) || issuer.length === 0) {
    refuse("issuer_untrusted", "issuer_signature");
  }
  await verifyAgainstTrustedIssuer(
    input.trustedIssuers,
    issuer,
    issuerJws.kid,
    issuerJws.alg,
    issuerJws,
  );

  const expiresAt = readEpochSeconds(
    issuerPayload.exp,
    "malformed_presentation",
    "credential_validity",
  );
  if (expiresAt !== null && expiresAt.getTime() + skewMs <= now.getTime()) {
    refuse("credential_expired", "credential_validity");
  }
  const notBefore = readEpochSeconds(
    issuerPayload.nbf,
    "malformed_presentation",
    "credential_validity",
  );
  if (notBefore !== null && notBefore.getTime() - skewMs > now.getTime()) {
    refuse("credential_not_yet_valid", "credential_validity");
  }
  // Read here rather than in the returned assurance record, which is built
  // after the session has been consumed: a refusal there would spend a session
  // on a response it then rejected. Nothing checks this value — it is reported,
  // not enforced — but a credential naming an unrepresentable issuance instant
  // is malformed whether or not we go on to use it.
  const issuedAt = readEpochSeconds(
    issuerPayload.iat,
    "malformed_presentation",
    "credential_validity",
  );

  const vct = issuerPayload.vct;
  if (!isString(vct) || !query.vctValues.includes(vct)) {
    // §B.3.5 makes `vct_values` the query's type constraint. A credential of
    // the wrong type that verifies perfectly is still the wrong answer.
    refuse("query_not_satisfied", "dcql_match");
  }

  // ---- 9. Key binding -----------------------------------------------------
  const holderJwk = readHolderPublicKey(issuerPayload.cnf);
  if (holderJwk === null) {
    refuse("holder_binding_failed", "key_binding");
  }
  // The holder does not get to choose the KB-JWT algorithm: it is pinned to
  // the key the *issuer* placed in `cnf`. Without this, a P-256 confirmation
  // key plus a header saying `EdDSA` would at best be an import error and at
  // worst a mismatch nobody notices.
  const holderAlgorithm = publicJwkAlgorithm(holderJwk);
  if (holderAlgorithm === null || holderAlgorithm !== keyBindingJws.alg) {
    refuse("algorithm_not_allowed", "key_binding");
  }
  await verifyCompactJws(
    keyBindingJws,
    holderJwk,
    "holder_binding_failed",
    "key_binding",
  );

  // Authoritative re-check: the bytes compared here are now covered by a
  // signature made with the key the issuer bound to this credential.
  if (
    !isString(keyBindingJws.payload.nonce) ||
    !constantTimeEquals(keyBindingJws.payload.nonce, request.nonce)
  ) {
    refuse("nonce_mismatch", "nonce_binding");
  }
  if (
    !isString(keyBindingJws.payload.aud) ||
    !constantTimeEquals(keyBindingJws.payload.aud, request.audience)
  ) {
    refuse("audience_mismatch", "audience_binding");
  }

  const sdAlgClaim = issuerPayload._sd_alg;
  const sdAlg: HashAlgorithm =
    sdAlgClaim === undefined
      ? DEFAULT_HASH_ALGORITHM
      : readHashAlgorithm(sdAlgClaim);

  // RFC 9901 §4.3.1: `sd_hash` binds the KB-JWT to *these* disclosures. Without
  // it a captured KB-JWT could be re-attached to the same credential with a
  // different, more revealing selection of disclosures.
  const sdHash = keyBindingJws.payload.sd_hash;
  if (
    !isString(sdHash) ||
    !constantTimeEquals(
      sdHash,
      hashStringToBase64url(sdAlg, parsed.keyBindingInput),
    )
  ) {
    refuse("holder_binding_failed", "key_binding");
  }

  const keyBoundAt = readEpochSeconds(
    keyBindingJws.payload.iat,
    "holder_binding_failed",
    "key_binding",
  );
  if (keyBoundAt === null) refuse("holder_binding_failed", "key_binding");
  const age = now.getTime() - keyBoundAt.getTime();
  if (age > maxAgeMs || age < -skewMs) {
    // Freshness is not redundant with the nonce. The nonce says "this answers
    // our request"; `iat` bounds how long a wallet may sit on a completed
    // proof before delivering it, which is what limits a stolen-response
    // window in the cross-device flow.
    refuse("holder_binding_failed", "key_binding");
  }

  // ---- 10. Transaction data, and the digest binding it carries ------------
  const boundTypes = verifyTransactionData(request, keyBindingJws.payload);
  assertRequestDigestBinding(request);

  // ---- 11. Disclosures ----------------------------------------------------
  const disclosures = guarded(
    "disclosure_digest",
    "malformed_presentation",
    () => readDisclosures(parsed.disclosures, sdAlg),
  );
  const resolved = guarded("disclosure_digest", "malformed_presentation", () =>
    resolveDisclosures(issuerPayload, disclosures),
  );
  const claims = withoutConfirmationKey(resolved);

  // ---- 12. Consume --------------------------------------------------------
  // Last, and atomic. Everything above is a pure function of the message, so a
  // failure leaves the session usable; success spends it.
  const consumed = await input.store.consume(state, now);
  if (!consumed) refuse("presentation_replayed", "session_consume");

  const thumbprint = await calculateJwkThumbprint(holderJwk);
  const scope = subjectScope ?? request.audience;

  return {
    subjectRef: `sub_${hashStringToBase64url(
      DEFAULT_HASH_ALGORITHM,
      `opensesame:openid4vp:subject:v1${SEPARATOR}${scope}${SEPARATOR}${thumbprint}`,
    )}`,
    // Scoped by the same value as `subjectRef`, and for the same reason.
    // The issuer-signed JWT is byte-identical at every verifier the holder
    // shows it to, so an unscoped digest of it is a global correlator minted
    // by the one component whose job is to prevent them — and a worse one
    // than the holder key beside it, because `cnf` at least differs between
    // credentials while a reissued-to-nobody JWT does not. §15.5's
    // verifier-to-verifier unlinkability has to hold for both handles or it
    // holds for neither, so the two derivations differ only in their purpose
    // string and the material they cover.
    credentialRef: `cred_${hashStringToBase64url(
      DEFAULT_HASH_ALGORITHM,
      `opensesame:openid4vp:credential:v1${SEPARATOR}${scope}${SEPARATOR}${parsed.issuerJwt}`,
    )}`,
    boundDigest: request.requestDigest,
    assurance: {
      format: query.format,
      issuer,
      issuerTrust: "configured_allowlist",
      credentialType: vct,
      holderBinding: "cryptographic_key_binding",
      credentialAlgorithm: issuerJws.alg,
      keyBindingAlgorithm: keyBindingJws.alg,
      keyBoundAt,
      credentialIssuedAt: issuedAt,
      credentialNotBefore: notBefore,
      credentialExpiresAt: expiresAt,
      transactionDataTypes: boundTypes,
      disclosedClaimNames: disclosures
        .map((disclosure) => disclosure.name)
        .filter((name): name is string => name !== null),
    },
    verifiedAt: now,
    claims,
  };
}

/**
 * Find a trusted key for `iss` and verify with it.
 *
 * Candidate selection is by issuer, then `kid` when both sides name one, then
 * by the key's own declared or derived algorithm. That last filter is what
 * makes algorithm confusion unreachable: a token asking for `HS256` never gets
 * here (the header allow-list refused it), and a token asking for `ES256`
 * cannot be matched against a key that is not an ES256 key.
 *
 * Every candidate failing produces `issuer_untrusted` rather than a distinct
 * "signature invalid" — an unknown issuer and a forged signature from a known
 * one are the same answer to the sender, and giving them different answers
 * turns the endpoint into an oracle for which issuers are configured.
 */
async function verifyAgainstTrustedIssuer(
  trustedIssuers: readonly TrustedIssuer[],
  issuer: string,
  kid: string | null,
  alg: SupportedSignatureAlgorithm,
  jws: CheckedCompactJws,
): Promise<void> {
  const entry = trustedIssuers.find((candidate) => candidate.issuer === issuer);
  if (entry === undefined) refuse("issuer_untrusted", "issuer_signature");
  const candidates = entry.keys.filter((key) => {
    if (key.d !== undefined) return false;
    if (kid !== null && key.kid !== undefined && key.kid !== kid) return false;
    if (key.alg !== undefined && key.alg !== alg) return false;
    return publicJwkAlgorithm(key) === alg;
  });
  if (candidates.length === 0) refuse("issuer_untrusted", "issuer_signature");
  for (const key of candidates) {
    try {
      await verifyCompactJws(jws, key, "issuer_untrusted", "issuer_signature");
      return;
    } catch {
      // Try the next key. The loop's own failure is raised below so that a
      // partial match never leaks which key was closest.
    }
  }
  refuse("issuer_untrusted", "issuer_signature");
}

/**
 * The algorithm a public JWK may be used with, or null.
 *
 * Derived from `kty`/`crv` rather than read from `alg`, because `alg` is
 * advisory and, for a key that arrived inside a credential, attacker-chosen.
 * RSA is absent for the reason given in `jose.ts`.
 */
function publicJwkAlgorithm(jwk: JWK): SupportedSignatureAlgorithm | null {
  if (jwk.kty === "EC") {
    if (jwk.x === undefined || jwk.y === undefined) return null;
    if (jwk.crv === "P-256") return "ES256";
    if (jwk.crv === "P-384") return "ES384";
    return null;
  }
  if (jwk.kty === "OKP") {
    if (jwk.x === undefined) return null;
    return jwk.crv === "Ed25519" ? "EdDSA" : null;
  }
  return null;
}

/**
 * Read `cnf.jwk` into a public JWK.
 *
 * Fields are copied one at a time rather than cast, so a `cnf` carrying `d`,
 * `k`, or an RSA modulus cannot reach `importJWK`. A private component inside
 * a credential is not a key the issuer bound a holder to; it is either a
 * catastrophic issuer bug or bait.
 */
function readHolderPublicKey(value: JsonValue | undefined): JWK | null {
  if (!isJsonObject(value)) return null;
  const inner = value.jwk;
  if (!isJsonObject(inner)) return null;
  if (inner.d !== undefined || inner.k !== undefined) return null;
  const kty = inner.kty;
  const crv = inner.crv;
  const x = inner.x;
  if (!isString(crv) || !isString(x)) return null;
  if (kty === "EC") {
    const y = inner.y;
    if (!isString(y)) return null;
    return { kty: "EC", crv, x, y };
  }
  if (kty === "OKP") {
    return { kty: "OKP", crv, x };
  }
  return null;
}

function readHashAlgorithm(value: JsonValue): HashAlgorithm {
  if (!isString(value) || !isHashAlgorithm(value)) {
    refuse("algorithm_not_allowed", "disclosure_digest");
  }
  return value;
}

/**
 * The window a NumericDate claim must land in, in seconds since the epoch.
 *
 * `Number.isFinite` is not enough on its own, and the gap it leaves is the
 * whole reason this range exists. `new Date(1e18)` is a perfectly finite
 * argument and an *Invalid Date*: every arithmetic use of it yields `NaN`, and
 * `NaN` compares false against `>`, `<` and `<=` alike. A claim in that region
 * therefore does not fail a time check — it deletes it, silently, while the
 * surrounding code still reads as if the check were there.
 *
 * The bounds are tighter than `Date`'s own ±8.64e15 ms because a JWT timestamp
 * outside them is not a clock reading anyone meant: below zero is before the
 * epoch the claim is defined against, and above is the year 10000. Both are
 * refused rather than clamped — a verifier that repairs a nonsensical
 * timestamp is deciding what a signer meant.
 */
const MIN_EPOCH_SECONDS = 0;
/** 9999-12-31T23:59:59Z. */
const MAX_EPOCH_SECONDS = 253_402_300_799;

/**
 * Read a NumericDate claim, or refuse.
 *
 * `null` means the claim was **absent**, which for `exp`, `nbf` and a
 * credential `iat` is legitimate and skips the check that would have used it.
 * A claim that is present and unreadable is refused instead, because mapping
 * it to `null` is how the bug this guards against gets its teeth: "present but
 * nonsense" would become "absent", and the check the signer's own claim asked
 * for would be skipped on the strength of the claim being wrong.
 *
 * The refusal code is the caller's, because the answer differs by claim. An
 * unusable KB-JWT `iat` is a holder-binding failure — there is no freshness
 * without it — while an unusable credential `exp` is a malformed credential.
 */
function readEpochSeconds(
  value: JsonValue | undefined,
  code: Openid4vpErrorCode,
  checkpoint: Openid4vpCheckpoint,
): Date | null {
  if (value === undefined) return null;
  if (!isNumber(value) || !Number.isFinite(value)) refuse(code, checkpoint);
  if (value < MIN_EPOCH_SECONDS || value > MAX_EPOCH_SECONDS) {
    refuse(code, checkpoint);
  }
  const date = new Date(value * 1000);
  // Belt and braces: the range above already excludes every input `Date`
  // cannot represent, and this is the assertion that keeps that true if the
  // range is ever widened.
  if (Number.isNaN(date.getTime())) refuse(code, checkpoint);
  return date;
}

/**
 * Read a caller-supplied tolerance, in milliseconds.
 *
 * Same failure mode as {@link readEpochSeconds}, one layer out: a skew or
 * max-age that multiplies to `NaN` makes every window comparison false, which
 * reads as "within tolerance" at each of the three sites that use one.
 */
function readDurationMs(seconds: number | undefined, fallback: number): number {
  const value = seconds ?? fallback;
  if (!isNumber(value) || !Number.isFinite(value) || value < 0) {
    refuse("malformed_presentation", "response_envelope");
  }
  return value * 1000;
}

/**
 * Compare the signed transaction-data hashes with the authorized set.
 *
 * Three failures, one code:
 *
 * - a **missing** hash means the holder authorized less than was asked, and
 *   the verifier must not treat a partial authorization as a full one;
 * - an **extra** hash means the holder signed something this request never
 *   sent, so its content is unknown to us and the signature over it is a
 *   liability, not an asset;
 * - a **mutated** entry produces a hash that matches nothing, which is the
 *   missing case with extra steps.
 *
 * Order is not one of them. §B.3.3.1 gives no ordering rule, the hashes are a
 * set, and both sides are sorted before comparison — reordering must pass, and
 * a verifier that demanded positional equality would reject honest wallets.
 */
function verifyTransactionData(
  request: AuthorizationRequest,
  payload: JsonObject,
): readonly string[] {
  const authorized = request.transactionData;
  const returnedHashes = payload.transaction_data_hashes;
  if (authorized.length === 0) {
    if (returnedHashes !== undefined) {
      refuse("transaction_data_mismatch", "transaction_data");
    }
    return [];
  }

  // §B.3.3.1: `transaction_data_hashes_alg` is REQUIRED in the KB-JWT when it
  // was present in the request — and this package always sends it.
  const declaredAlg = payload.transaction_data_hashes_alg;
  if (!isString(declaredAlg) || !isHashAlgorithm(declaredAlg)) {
    refuse("transaction_data_mismatch", "transaction_data");
  }
  for (const entry of authorized) {
    if (!entry.hashAlgorithms.includes(declaredAlg)) {
      // "the hash function MUST be one of its values" — a wallet that picks
      // outside the offered set has computed digests we did not authorize.
      refuse("transaction_data_mismatch", "transaction_data");
    }
  }

  if (!Array.isArray(returnedHashes) || returnedHashes.length === 0) {
    refuse("transaction_data_mismatch", "transaction_data");
  }
  const returned: string[] = [];
  for (const hash of returnedHashes) {
    if (!isString(hash))
      refuse("transaction_data_mismatch", "transaction_data");
    returned.push(hash);
  }
  const expected = authorized.map((entry) =>
    transactionDataHash(entry.encoded, declaredAlg),
  );
  if (returned.length !== expected.length) {
    refuse("transaction_data_mismatch", "transaction_data");
  }
  const sortedReturned = [...returned].sort();
  const sortedExpected = [...expected].sort();
  for (let index = 0; index < sortedExpected.length; index += 1) {
    const left = sortedExpected[index];
    const right = sortedReturned[index];
    if (left === undefined || right === undefined || left !== right) {
      refuse("transaction_data_mismatch", "transaction_data");
    }
  }
  return authorized.map((entry) => entry.type);
}

/**
 * Confirm the digest the holder signed over is this request's digest.
 *
 * By the time this runs, `verifyTransactionData` has proved the holder's
 * signature covers a hash of every authorized entry's exact encoded bytes. So
 * decoding the binding entry and finding our digest inside it upgrades the
 * caller's cross-check in step 3 from "two values I hold agree" to "the holder
 * signed a statement naming this request".
 */
function assertRequestDigestBinding(request: AuthorizationRequest): void {
  const binding = request.transactionData.find(
    (entry) => entry.type === REQUEST_BINDING_TRANSACTION_DATA_TYPE,
  );
  if (binding === undefined) refuse("digest_mismatch", "request_binding");
  const decoded = guarded("request_binding", "digest_mismatch", () => {
    const parsed: JsonValue = JSON.parse(
      decodeUtf8(decodeBase64url(binding.encoded)),
    );
    if (!isJsonObject(parsed)) throw new SyntaxError("not an object");
    return parsed;
  });
  const digest = decoded.request_digest;
  if (!isString(digest) || !constantTimeEquals(digest, request.requestDigest)) {
    refuse("digest_mismatch", "request_binding");
  }
}

/**
 * Drop `cnf` from the returned claims.
 *
 * `_sd` and `_sd_alg` are already gone — `resolveDisclosures` never copies
 * them. `cnf` survives that pass because it is an ordinary claim, and it must
 * not survive this one: it is the holder's public key, it is the single most
 * effective cross-verifier correlator in the credential, and `subjectRef`
 * already carries everything a caller legitimately needs from it.
 */
function withoutConfirmationKey(claims: JsonObject): JsonObject {
  const out: MutableJsonObject = {};
  for (const key of Object.keys(claims)) {
    if (key === "cnf") continue;
    const value = claims[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
