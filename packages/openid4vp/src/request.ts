/**
 * Building the ask.
 *
 * A verifier's request is not a form; it is the half of a signed statement
 * that the wallet completes. Every value here reappears inside the holder's
 * signature — the nonce as `nonce`, the client identifier as `aud`, the
 * transaction data as a set of hashes — so a request built loosely produces a
 * presentation that proves less than it appears to.
 *
 * Three choices in this file are worth defending up front.
 *
 * **The nonce is 32 bytes.** OpenID4VP 1.0 §5.2 asks for "a fresh,
 * cryptographically random number with sufficient entropy" and stops there.
 * The nonce is the only thing preventing a presentation captured from one
 * session being posted to another, and it travels through a QR code that
 * anyone can photograph, so it is sized to be unguessable rather than short.
 *
 * **Every request carries a transaction-data entry binding it to an OpenSesame
 * request digest.** Nonce equality proves a presentation answers *this
 * session*; it does not prove which request the session held, because the
 * nonce is random and says nothing about the request's contents. Putting the
 * digest into `transaction_data` gets it inside the holder's signature
 * (§B.3.3.1: the KB-JWT returns a hash over each entry), which turns "the
 * caller believes this VP settles interaction X" into something checkable.
 * The cost is real and stated in `SUPPORT_MATRIX`: §8.4 requires a wallet that
 * cannot process `transaction_data` to reject the request outright, so this
 * verifier does not interoperate with wallets that lack it.
 *
 * **The request digest is computed before the binding entry exists.** It
 * covers the nonce, state, client identifier, response mode and URI, the DCQL
 * query, the caller's own transaction data, and the expiry — everything that
 * determines what is being asked — and then the binding entry carries it. A
 * digest that tried to cover itself would not terminate.
 *
 * A consequence of that binding entry, and the reason
 * {@link intersectHashAlgorithms} exists: §B.3.3.1 lets the wallet pick **one**
 * hash algorithm for the whole `transaction_data_hashes` array, and the
 * verifier requires that choice to be offered by *every* authorized entry. So
 * the entry this file appends is not free to name its own algorithm — an entry
 * offering only `sha-256` beside a caller entry offering only `sha-384` is a
 * request no conforming wallet can satisfy. The failure would surface at
 * verification, which is after the wallet has rendered the transaction and a
 * human has approved it: the worst possible moment to discover that the ask was
 * malformed. So the sets are reconciled here, at construction, where the only
 * party inconvenienced is the caller who wrote the request.
 */

import {
  type JsonObject,
  type MutableJsonObject,
  canonicalize,
  digestManifest,
} from "@opensesame/os-domain";
import { type KeyInput, SignJWT } from "jose";
import {
  DEFAULT_HASH_ALGORITHM,
  type HashAlgorithm,
  SUPPORTED_HASH_ALGORITHMS,
  encodeStringBase64url,
  hashStringToBase64url,
  randomBase64url,
} from "./encoding.js";
import { refuse } from "./errors.js";
import {
  REQUEST_OBJECT_TYP,
  type SupportedSignatureAlgorithm,
} from "./jose.js";

/**
 * Credential Format Identifiers this package recognizes by name.
 *
 * Recognizing is not supporting. `mso_mdoc` is listed so that a response
 * carrying one is refused as "a format we know and do not verify" rather than
 * falling through a default branch — see `VERIFIABLE_CREDENTIAL_FORMATS`.
 */
export const KNOWN_CREDENTIAL_FORMATS = [
  "dc+sd-jwt",
  "vc+sd-jwt",
  "mso_mdoc",
] as const;

export type CredentialFormat = (typeof KNOWN_CREDENTIAL_FORMATS)[number];

/**
 * Formats this verifier can actually check end to end.
 *
 * `mso_mdoc` is absent. Verifying one means CBOR, COSE_Sign1, an IssuerAuth
 * MSO, device authentication over a SessionTranscript whose construction
 * differs between redirect and DC API invocation (§B.2.6), and an X.509 IACA
 * trust chain — none of which is reachable from `jose`, and all of which would
 * be a second, unrelated credential stack in a package whose value is that its
 * verification path is short enough to read. Declaring it unsupported and
 * refusing it by name is honest; accepting it and checking only the parts that
 * happen to be easy would not be.
 */
export const VERIFIABLE_CREDENTIAL_FORMATS = [
  "dc+sd-jwt",
  "vc+sd-jwt",
] as const;

export type VerifiableCredentialFormat =
  (typeof VERIFIABLE_CREDENTIAL_FORMATS)[number];

export function isKnownCredentialFormat(
  value: string,
): value is CredentialFormat {
  return KNOWN_CREDENTIAL_FORMATS.some((candidate) => candidate === value);
}

export function isVerifiableCredentialFormat(
  value: string,
): value is VerifiableCredentialFormat {
  return VERIFIABLE_CREDENTIAL_FORMATS.some((candidate) => candidate === value);
}

/**
 * Response modes this verifier is willing to be the other end of.
 *
 * `direct_post.jwt` and `dc_api.jwt` are the encrypted variants (§8.3): the
 * wallet returns a JWE whose payload is the authorization response, encrypted
 * to a key the verifier published in `client_metadata.jwks`. They are absent
 * because this package does not decrypt responses, and a verifier that
 * *requests* a mode it cannot read is worse than one that does not offer it —
 * the wallet does the work, the user consents, and the response is discarded
 * at the door.
 */
export const SUPPORTED_RESPONSE_MODES = ["direct_post", "dc_api"] as const;

export type SupportedResponseMode = (typeof SUPPORTED_RESPONSE_MODES)[number];

/**
 * Client Identifier Prefixes (§5.9.3) this package will build a request under.
 *
 * `redirect_uri` needs no verifier key at all and is the sane default for a
 * plain web verifier; §5.9.3 also states that requests using it *cannot* be
 * signed, which {@link signRequestObject} enforces. `x509_san_dns` and
 * `x509_hash` are the two prefixes whose trust anchor is Web-PKI-shaped and so
 * reachable with an `x5c` header and nothing else.
 *
 * `openid_federation`, `decentralized_identifier` and `verifier_attestation`
 * are absent: each requires the *verifier* to participate in a trust
 * infrastructure (a federation trust chain, DID resolution, an attestation
 * issuer) that this package has no business embedding. `origin` is absent
 * because §5.9.3 forbids sending it — the platform supplies it.
 */
export const REQUESTABLE_CLIENT_ID_PREFIXES = [
  "redirect_uri",
  "x509_san_dns",
  "x509_hash",
] as const;

export type RequestableClientIdPrefix =
  (typeof REQUESTABLE_CLIENT_ID_PREFIXES)[number];

/** The prefix of a Client Identifier, or null for a pre-registered client. */
export function clientIdPrefix(clientId: string): string | null {
  const colon = clientId.indexOf(":");
  if (colon <= 0) return null;
  return clientId.slice(0, colon);
}

/**
 * A claims path pointer (§7) — the DCQL way of naming a claim.
 *
 * `null` selects every element of an array; a number selects one index. Kept
 * as data rather than a dotted string because a dotted string cannot express
 * either without an escaping rule.
 */
export interface DcqlClaimQuery {
  readonly path: readonly (string | number | null)[];
  readonly id?: string | undefined;
}

/**
 * One Credential Query (§6.1).
 *
 * `vctValues` is promoted out of the format-specific `meta` object and made
 * required because §B.3.5 makes `vct_values` REQUIRED for `dc+sd-jwt`, and it
 * is the only part of the query this verifier actually re-checks against the
 * returned credential.
 */
export interface DcqlCredentialQuery {
  readonly id: string;
  readonly format: VerifiableCredentialFormat;
  readonly vctValues: readonly string[];
  readonly claims?: readonly DcqlClaimQuery[] | undefined;
}

export interface DcqlQuery {
  readonly credentials: readonly DcqlCredentialQuery[];
}

/** `id` values are constrained by §6.1 to this alphabet. */
const DCQL_ID = /^[A-Za-z0-9_-]+$/;

/** A transaction-data entry as the caller describes it. */
export interface TransactionDataInput {
  readonly type: string;
  /** DCQL query ids whose credential may authorize this transaction. */
  readonly credentialIds: readonly string[];
  /** Hash algorithms the wallet may choose between. Defaults to `sha-256`. */
  readonly hashAlgorithms?: readonly HashAlgorithm[] | undefined;
  /** Type-specific members, merged into the encoded object. */
  readonly parameters?: JsonObject | undefined;
}

/** A transaction-data entry as it goes on the wire, with its digest. */
export interface EncodedTransactionData {
  readonly type: string;
  readonly credentialIds: readonly string[];
  readonly hashAlgorithms: readonly HashAlgorithm[];
  /** The base64url string sent in `transaction_data`. */
  readonly encoded: string;
  /**
   * `sha-256` digest of {@link encoded}, base64url.
   *
   * The default the wallet must use when it does not echo an algorithm. For
   * any other offered algorithm the verifier recomputes with
   * {@link transactionDataHash}; storing one digest per offered algorithm
   * would imply the set is closed at build time, and it is not — the wallet
   * picks.
   */
  readonly hash: string;
}

/** Members this package owns inside a transaction-data object. */
const RESERVED_TRANSACTION_DATA_MEMBERS: readonly string[] = [
  "type",
  "credential_ids",
  "transaction_data_hashes_alg",
];

/**
 * The transaction-data type that binds a presentation to an OpenSesame
 * request digest.
 *
 * Collision-resistant per §5.1's recommendation, and defined here rather than
 * borrowed so that the members it carries (`request_digest`) are ours to
 * validate. §8.5 makes a known type with unknown fields an
 * `invalid_transaction_data` error at the wallet, so the shape is fixed.
 */
export const REQUEST_BINDING_TRANSACTION_DATA_TYPE =
  "opensesame_request_binding";

/**
 * Encode one transaction-data entry and digest it.
 *
 * The JSON is canonicalized (sorted keys, via the shared domain
 * canonicalizer) before encoding. Not because any specification requires it —
 * the wallet hashes the exact string it received, so any serialization would
 * verify — but because the digest is a value this system stores in receipts
 * and compares across processes, and a digest that changed with `JSON`
 * key-insertion order would be a source of irreproducible audit trails.
 */
export function buildTransactionData(
  input: TransactionDataInput,
): EncodedTransactionData {
  if (input.type.length === 0) {
    refuse("malformed_presentation", "request_construction");
  }
  if (input.credentialIds.length === 0) {
    // §5.1: `credential_ids` is a REQUIRED non-empty array. An entry nothing
    // can authorize is an entry the wallet must reject.
    refuse("malformed_presentation", "request_construction");
  }
  const hashAlgorithms =
    input.hashAlgorithms === undefined || input.hashAlgorithms.length === 0
      ? [DEFAULT_HASH_ALGORITHM]
      : [...input.hashAlgorithms];

  const object: MutableJsonObject = {};
  const parameters = input.parameters;
  if (parameters !== undefined) {
    for (const key of Object.keys(parameters)) {
      if (RESERVED_TRANSACTION_DATA_MEMBERS.includes(key)) {
        refuse("malformed_presentation", "request_construction");
      }
      const value = parameters[key];
      if (value !== undefined) object[key] = value;
    }
  }
  object.type = input.type;
  object.credential_ids = [...input.credentialIds];
  object.transaction_data_hashes_alg = [...hashAlgorithms];

  const encoded = encodeStringBase64url(canonicalize(object));
  return {
    type: input.type,
    credentialIds: [...input.credentialIds],
    hashAlgorithms,
    encoded,
    hash: hashStringToBase64url(DEFAULT_HASH_ALGORITHM, encoded),
  };
}

/**
 * Digest of a transaction-data entry under a specific algorithm.
 *
 * §B.3.3.1: the hash covers "the string received in the transaction_data
 * request parameter (base64url decoding is not performed before hashing)".
 */
export function transactionDataHash(
  encoded: string,
  alg: HashAlgorithm,
): string {
  return hashStringToBase64url(alg, encoded);
}

/** What the caller asks for. */
export interface AuthorizationRequestInput {
  /**
   * The full Client Identifier including its prefix, for `direct_post`.
   *
   * Omitted for `dc_api`, where §A.2 requires `client_id` to be absent from an
   * unsigned request and the audience is derived from the browser-authenticated
   * origin instead.
   */
  readonly clientId?: string | undefined;
  readonly responseMode: SupportedResponseMode;
  /** REQUIRED for `direct_post` (§8.2). */
  readonly responseUri?: string | undefined;
  /** REQUIRED for `dc_api`: the verifier origin the platform will authenticate. */
  readonly origin?: string | undefined;
  readonly dcqlQuery: DcqlQuery;
  readonly transactionData?: readonly TransactionDataInput[] | undefined;
  readonly clientMetadata?: JsonObject | undefined;
  /** Default 300s. The wallet round trip includes a human reading a screen. */
  readonly ttlSeconds?: number | undefined;
  readonly now?: Date | undefined;
}

/**
 * A built request, and simultaneously the record a request session stores.
 *
 * One type rather than two so a field cannot be present on the wire and absent
 * from the session that must later prove the response matches it.
 */
export interface AuthorizationRequest {
  /** 32 random bytes, base64url. */
  readonly nonce: string;
  readonly state: string;
  readonly clientId: string | null;
  readonly responseMode: SupportedResponseMode;
  readonly responseUri: string | null;
  /**
   * The value the presentation's `aud` must equal.
   *
   * For `direct_post` this is the Client Identifier. For `dc_api` it is
   * `origin:<origin>` — §5.9.3 and §B.3.6 both state that over the DC API the
   * audience is the origin with that prefix, never the client id.
   */
  readonly audience: string;
  readonly dcqlQuery: DcqlQuery;
  readonly transactionData: readonly EncodedTransactionData[];
  readonly clientMetadata: JsonObject | null;
  /** `sha256:<hex>` over the canonical request. */
  readonly requestDigest: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

const DEFAULT_TTL_SECONDS = 300;
/** 32 bytes: the nonce is the anti-replay value and travels in a QR code. */
const NONCE_BYTES = 32;
/** 24 bytes: `state` only needs to be unguessable as a session handle. */
const STATE_BYTES = 24;

export function buildAuthorizationRequest(
  input: AuthorizationRequestInput,
): AuthorizationRequest {
  const credentials = input.dcqlQuery.credentials;
  // Exactly one, not "at least one". A response to a multi-credential query
  // yields several independent presentations with independent trust
  // conclusions, and `VerifiedPresentation` describes one. Rather than return
  // a shape that pretends several were reduced to one, this package declines
  // the request — see `SUPPORT_MATRIX`.
  if (credentials.length !== 1) {
    refuse("malformed_presentation", "request_construction");
  }
  const ids = new Set<string>();
  for (const query of credentials) {
    if (!DCQL_ID.test(query.id) || ids.has(query.id)) {
      // §6.1: ids are alphanumeric/underscore/hyphen and unique within a
      // request. A duplicate id makes the response's `vp_token` ambiguous.
      refuse("malformed_presentation", "request_construction");
    }
    ids.add(query.id);
    if (!isVerifiableCredentialFormat(query.format)) {
      refuse("format_not_supported", "request_construction");
    }
    if (query.vctValues.length === 0) {
      refuse("malformed_presentation", "request_construction");
    }
  }

  const now = input.now ?? new Date();
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    refuse("malformed_presentation", "request_construction");
  }

  let clientId: string | null;
  let audience: string;
  let responseUri: string | null;
  if (input.responseMode === "direct_post") {
    const declared = input.clientId;
    if (declared === undefined || declared.length === 0) {
      refuse("malformed_presentation", "request_construction");
    }
    const prefix = clientIdPrefix(declared);
    if (prefix !== null && !isRequestableClientIdPrefix(prefix)) {
      // A recognized-but-unsupported prefix (`openid_federation`, a DID, an
      // attestation) would make the wallet expect trust processing this
      // verifier cannot perform. An unrecognized prefix would be read by the
      // wallet as a pre-registered client id, which is not what the caller
      // meant. Both are refused here rather than discovered at the wallet.
      refuse("malformed_presentation", "request_construction");
    }
    const uri = input.responseUri;
    if (uri === undefined || uri.length === 0) {
      refuse("malformed_presentation", "request_construction");
    }
    clientId = declared;
    audience = declared;
    responseUri = uri;
  } else {
    const origin = input.origin;
    if (origin === undefined || origin.length === 0) {
      refuse("malformed_presentation", "request_construction");
    }
    if (input.clientId !== undefined) {
      // §A.2: "The client_id parameter MUST be omitted in unsigned requests."
      refuse("malformed_presentation", "request_construction");
    }
    clientId = null;
    audience = `origin:${origin}`;
    responseUri = null;
  }

  const callerEntries = (input.transactionData ?? []).map((entry) => {
    for (const credentialId of entry.credentialIds) {
      if (!ids.has(credentialId)) {
        // §5.1: each string "matches the id field in the DCQL Credential
        // Query". An entry pointing at a credential we never asked for cannot
        // be authorized by anything in the response.
        refuse("malformed_presentation", "request_construction");
      }
    }
    if (entry.type === REQUEST_BINDING_TRANSACTION_DATA_TYPE) {
      refuse("malformed_presentation", "request_construction");
    }
    return buildTransactionData(entry);
  });

  const bindingHashAlgorithms = intersectHashAlgorithms(callerEntries);

  const nonce = randomBase64url(NONCE_BYTES);
  const state = randomBase64url(STATE_BYTES);
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  const core: JsonObject = {
    audience,
    client_id: clientId,
    dcql_query: dcqlQueryToJson(input.dcqlQuery),
    expires_at: expiresAt.toISOString(),
    nonce,
    response_mode: input.responseMode,
    response_uri: responseUri,
    state,
    transaction_data: callerEntries.map((entry) => entry.encoded),
  };
  const requestDigest = digestManifest(core);

  const bindingEntry = buildTransactionData({
    type: REQUEST_BINDING_TRANSACTION_DATA_TYPE,
    credentialIds: [...ids],
    hashAlgorithms: bindingHashAlgorithms,
    parameters: { request_digest: requestDigest },
  });

  return {
    nonce,
    state,
    clientId,
    responseMode: input.responseMode,
    responseUri,
    audience,
    dcqlQuery: input.dcqlQuery,
    transactionData: [...callerEntries, bindingEntry],
    clientMetadata: input.clientMetadata ?? null,
    requestDigest,
    createdAt: now,
    expiresAt,
  };
}

/**
 * The algorithms every caller entry offers, for the appended binding entry.
 *
 * §B.3.3.1 gives the wallet one `transaction_data_hashes_alg` for the whole
 * array, and `verifyTransactionData` holds it to the intersection of the
 * offered sets. The binding entry must therefore offer at least that
 * intersection or it narrows what the request is satisfiable with; offering
 * exactly it is the choice that adds nothing and removes nothing.
 *
 * Iteration is over {@link SUPPORTED_HASH_ALGORITHMS} rather than over the
 * caller's arrays, so the result is in one canonical order and deduplicated
 * whatever order or repetition the caller wrote. Two requests asking the same
 * thing then produce the same bytes on the wire.
 *
 * With no caller entries there is nothing to intersect, and the answer is the
 * default rather than "everything": `sha-256` is the algorithm §B.3.3.1 makes
 * mandatory to implement, so a request offering only it is the one every wallet
 * can answer. Widening a request nobody asked to have widened is not this
 * function's call to make.
 */
function intersectHashAlgorithms(
  entries: readonly EncodedTransactionData[],
): readonly HashAlgorithm[] {
  if (entries.length === 0) return [DEFAULT_HASH_ALGORITHM];
  const shared = SUPPORTED_HASH_ALGORITHMS.filter((candidate) =>
    entries.every((entry) => entry.hashAlgorithms.includes(candidate)),
  );
  if (shared.length === 0) {
    // The caller's own entries already disagree — one offers only `sha-384`,
    // another only `sha-512` — so no single wallet choice satisfies the array
    // and no binding entry this function could append would rescue it. Refused
    // by the same code as every other construction-time refusal, at the
    // `request_construction` checkpoint that says where it happened.
    refuse("malformed_presentation", "request_construction");
  }
  return shared;
}

function isRequestableClientIdPrefix(
  value: string,
): value is RequestableClientIdPrefix {
  return REQUESTABLE_CLIENT_ID_PREFIXES.some(
    (candidate) => candidate === value,
  );
}

export function dcqlQueryToJson(query: DcqlQuery): JsonObject {
  return {
    credentials: query.credentials.map((credential) => {
      const entry: MutableJsonObject = {
        id: credential.id,
        format: credential.format,
        meta: { vct_values: [...credential.vctValues] },
      };
      if (credential.claims !== undefined) {
        entry.claims = credential.claims.map((claim) => {
          const claimEntry: MutableJsonObject = { path: [...claim.path] };
          if (claim.id !== undefined) claimEntry.id = claim.id;
          return claimEntry;
        });
      }
      return entry;
    }),
  };
}

/**
 * The Authorization Request parameters for the redirect / `request_uri` flow.
 *
 * Object-valued parameters are returned as objects, not as the
 * JSON-serialized strings §5.1 requires on the wire, because the caller may be
 * putting them into a JAR claim set (where they stay objects) or into a query
 * string (where they do not). Serializing here would force the JAR path to
 * parse them back.
 */
export function authorizationRequestParameters(
  request: AuthorizationRequest,
): JsonObject {
  if (request.responseMode !== "direct_post") {
    refuse("response_mode_mismatch", "request_construction");
  }
  const parameters: MutableJsonObject = {
    response_type: "vp_token",
    response_mode: request.responseMode,
    client_id: request.clientId,
    response_uri: request.responseUri,
    nonce: request.nonce,
    state: request.state,
    dcql_query: dcqlQueryToJson(request.dcqlQuery),
    transaction_data: request.transactionData.map((entry) => entry.encoded),
  };
  if (request.clientMetadata !== null) {
    parameters.client_metadata = request.clientMetadata;
  }
  return parameters;
}

/**
 * The JOSE header of a signed Request Object.
 *
 * Named here rather than borrowed from `jose`, whose `JWSHeaderParameters`
 * carries an open `unknown` index signature: this header has exactly four
 * members and stating that is the difference between a contract and a bag.
 */
type RequestObjectHeader = {
  alg: SupportedSignatureAlgorithm;
  typ: string;
  kid?: string;
  x5c?: string[];
};

/** A key the verifier may sign a Request Object with. */
export interface RequestObjectSigningKey {
  readonly alg: SupportedSignatureAlgorithm;
  readonly key: KeyInput;
  readonly kid?: string | undefined;
  /** Leaf-first certificate chain, required by both `x509_*` prefixes. */
  readonly x5c?: readonly string[] | undefined;
}

/**
 * `aud` for a Request Object under static discovery (§5.8).
 *
 * A symbolic string, not a URL that is fetched. §5.8 permits it standalone,
 * outside SIOPv2, and it is the correct value whenever the verifier does not
 * know which wallet will read the request — which, for a QR code, is always.
 */
export const STATIC_DISCOVERY_AUDIENCE = "https://self-issued.me/v2";

/**
 * Sign a Request Object (JAR, RFC 9101).
 *
 * Refuses the `redirect_uri` prefix outright. §5.9.3 is explicit that requests
 * using it "cannot be signed because there is no method for the Wallet to
 * obtain a trusted key for verification" — a signature the wallet cannot
 * anchor is not a weaker signature, it is a decoration that invites the
 * reader to believe the request was authenticated.
 */
export async function signRequestObject(
  request: AuthorizationRequest,
  signingKey: RequestObjectSigningKey,
): Promise<string> {
  const parameters = authorizationRequestParameters(request);
  const clientId = request.clientId;
  if (clientId === null) {
    refuse("malformed_presentation", "request_construction");
  }
  const prefix = clientIdPrefix(clientId);
  if (prefix === null || prefix === "redirect_uri") {
    refuse("malformed_presentation", "request_construction");
  }
  const protectedHeader: RequestObjectHeader = {
    alg: signingKey.alg,
    typ: REQUEST_OBJECT_TYP,
  };
  // `kid` and `x5c` are how the wallet finds the key: the DID and federation
  // prefixes select on `kid`, and both `x509_*` prefixes require the chain in
  // `x5c` (§5.9.3). Absent means absent, not present-and-empty.
  if (signingKey.kid !== undefined) protectedHeader.kid = signingKey.kid;
  if (signingKey.x5c !== undefined) protectedHeader.x5c = [...signingKey.x5c];

  const claims: MutableJsonObject = { ...parameters };
  claims.iss = clientId;
  claims.aud = STATIC_DISCOVERY_AUDIENCE;

  return await new SignJWT(claims)
    .setProtectedHeader(protectedHeader)
    .setIssuedAt(Math.floor(request.createdAt.getTime() / 1000))
    .setExpirationTime(Math.floor(request.expiresAt.getTime() / 1000))
    .sign(signingKey.key);
}

/**
 * Protocol identifiers registered by OpenID4VP 1.0 §A.1.
 *
 * The bare string `openid4vp` was the pre-final value and is not one of them:
 * §A.1 replaced it with `openid4vp-v<version>-<request-type>` precisely so a
 * wallet need not guess which draft a request follows. This package emits the
 * unsigned form, which is the only one it builds — see `SUPPORT_MATRIX`.
 */
export const DC_API_PROTOCOL_UNSIGNED = "openid4vp-v1-unsigned";

export interface DigitalCredentialsRequest {
  readonly protocol: typeof DC_API_PROTOCOL_UNSIGNED;
  readonly data: JsonObject;
}

/**
 * Project a request into the W3C Digital Credentials API request shape.
 *
 * The result is the object a browser passes to
 * `navigator.credentials.get({ digital: { requests: [ ... ] } })`. Note what is
 * *not* in `data`: no `client_id` (§A.2 forbids it unsigned), no `state`
 * (§A.2: not defined for the DC API, so the response will not echo it), and no
 * `response_uri` (the response comes back through the API, not a POST).
 */
export function digitalCredentialsRequest(
  request: AuthorizationRequest,
): DigitalCredentialsRequest {
  if (request.responseMode !== "dc_api") {
    refuse("response_mode_mismatch", "request_construction");
  }
  const data: MutableJsonObject = {
    response_type: "vp_token",
    response_mode: "dc_api",
    nonce: request.nonce,
    dcql_query: dcqlQueryToJson(request.dcqlQuery),
    transaction_data: request.transactionData.map((entry) => entry.encoded),
  };
  if (request.clientMetadata !== null) {
    data.client_metadata = request.clientMetadata;
  }
  return { protocol: DC_API_PROTOCOL_UNSIGNED, data };
}
