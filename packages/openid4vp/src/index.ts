/**
 * `@opensesame/openid4vp` — the verifier half of OpenID4VP 1.0.
 *
 * OpenSesame already acts as a holder: `apps/authenticator-native` presents
 * credentials through Multipaz (ADR 0058). This package is the other end of
 * that conversation — the side that *asks* a wallet to prove something and
 * then binds the proof to an authorization decision. It is server-side, has no
 * database dependency, and returns evidence rather than tokens.
 *
 * Read {@link SUPPORT_MATRIX} before citing this package anywhere. It is the
 * honest inventory: what was implemented, what was recognized and refused, and
 * why. Documentation that describes this verifier should quote it rather than
 * paraphrase it, because the paraphrase always drifts optimistic.
 */

export {
  type Openid4vpCheckpoint,
  type Openid4vpErrorCode,
  Openid4vpError,
  isOpenid4vpError,
} from "./errors.js";

export {
  type HashAlgorithm,
  DEFAULT_HASH_ALGORITHM,
  SUPPORTED_HASH_ALGORITHMS,
  isHashAlgorithm,
} from "./encoding.js";

export {
  type CheckedCompactJws,
  type SupportedSignatureAlgorithm,
  KEY_BINDING_JWT_TYP,
  REQUEST_OBJECT_TYP,
  SD_JWT_VC_TYPS,
  SUPPORTED_SIGNATURE_ALGORITHMS,
  isSupportedSignatureAlgorithm,
  readSignedCompactJws,
} from "./jose.js";

export {
  type AuthorizationRequest,
  type AuthorizationRequestInput,
  type CredentialFormat,
  type DcqlClaimQuery,
  type DcqlCredentialQuery,
  type DcqlQuery,
  type DigitalCredentialsRequest,
  type EncodedTransactionData,
  type RequestObjectSigningKey,
  type RequestableClientIdPrefix,
  type SupportedResponseMode,
  type TransactionDataInput,
  type VerifiableCredentialFormat,
  DC_API_PROTOCOL_UNSIGNED,
  KNOWN_CREDENTIAL_FORMATS,
  REQUESTABLE_CLIENT_ID_PREFIXES,
  REQUEST_BINDING_TRANSACTION_DATA_TYPE,
  STATIC_DISCOVERY_AUDIENCE,
  SUPPORTED_RESPONSE_MODES,
  VERIFIABLE_CREDENTIAL_FORMATS,
  authorizationRequestParameters,
  buildAuthorizationRequest,
  buildTransactionData,
  clientIdPrefix,
  dcqlQueryToJson,
  digitalCredentialsRequest,
  isKnownCredentialFormat,
  isVerifiableCredentialFormat,
  signRequestObject,
  transactionDataHash,
} from "./request.js";

export {
  type InMemoryRequestSessionStoreOptions,
  type RequestSessionRecord,
  type RequestSessionStore,
  InMemoryRequestSessionStore,
} from "./session.js";

export {
  type Disclosure,
  type ParsedSdJwt,
  parseSdJwt,
  readDisclosures,
  resolveDisclosures,
} from "./sd-jwt.js";

export {
  type PresentationAssurance,
  type PresentationResponse,
  type TrustedIssuer,
  type VerifiedPresentation,
  type VerifyPresentationInput,
  verifyPresentation,
} from "./verify.js";

/**
 * The conformance statement for this package.
 *
 * Every entry is either something the code does or something the code refuses;
 * there is no "planned" column. `notSupported` exists because a support matrix
 * that lists only capabilities is a marketing document — the interesting
 * question for anyone integrating a verifier is what it will silently decline
 * to check, and each entry here answers that with a reason rather than a
 * roadmap.
 */
export const SUPPORT_MATRIX = {
  /** OpenID4VP 1.0, Final, published 9 July 2025 (Terbu, Lodderstedt,
   * Yasuda, Fett, Heenan; OpenID Digital Credentials Protocols WG). */
  specification: {
    name: "OpenID for Verifiable Presentations 1.0",
    status: "Final",
    published: "2025-07-09",
    url: "https://openid.net/specs/openid-4-verifiable-presentations-1_0.html",
  },
  /** Credential-format specifications this verifier implements against. */
  credentialSpecifications: [
    {
      name: "Selective Disclosure for JSON Web Tokens (SD-JWT)",
      status: "RFC 9901",
      published: "2025-11-19",
      url: "https://www.rfc-editor.org/rfc/rfc9901.html",
    },
    {
      /**
       * Still an Internet-Draft, and pinned to the same revision as
       * `@opensesame/openid4vci`'s matrix because the two packages are the two
       * ends of one credential and a verifier reading a different revision from
       * the issuer that minted the token is exactly the interoperability bug a
       * support matrix is supposed to make visible.
       *
       * -18 rather than the -11 this entry named until now, and the evidence is
       * in the code rather than in a preference for the larger number. This
       * package is written against RFC 9901 throughout — `sd_hash` per §4.3.1,
       * the digest-over-base64url-text rule of §4.2.3, the §7.3 KB-JWT
       * processing — and -11 predates RFC 9901's publication, normatively
       * referencing draft-ietf-oauth-selective-disclosure-jwt-22 instead. The
       * sibling issuer already cites §2.2.2.3 for the claims that may not be
       * selectively disclosed, which is -18's section numbering; the same rule
       * is §3.2.2.2 in -11. Nothing this verifier checks differs between the
       * two revisions, so this is a citation correction and not a behaviour
       * change — but citing a revision the code does not read is how a matrix
       * stops being quotable.
       */
      name: "SD-JWT-based Verifiable Digital Credentials (SD-JWT VC)",
      status: "draft-ietf-oauth-sd-jwt-vc-18",
      published: "2026-08-03",
      url: "https://datatracker.ietf.org/doc/html/draft-ietf-oauth-sd-jwt-vc-18",
    },
  ],
  role: "verifier",
  /** §8.2 for `direct_post`; Appendix A for the DC API. */
  responseModes: ["direct_post", "dc_api"],
  /** §6. Presentation Exchange is not implemented and is legacy in 1.0. */
  queryMechanism: "dcql",
  /** §B.3.1, plus the legacy `typ` spelling SD-JWT VC §3.1 asks verifiers to accept. */
  credentialFormats: ["dc+sd-jwt", "vc+sd-jwt"],
  /** Enforced against every JOSE header before any key is imported. */
  signatureAlgorithms: ["ES256", "ES384", "EdDSA"],
  /**
   * §B.3.3.1, including the KB-JWT `transaction_data_hashes` round trip.
   *
   * All three are usable end to end, not merely recognized. §B.3.3.1 lets the
   * wallet choose one algorithm for the whole array and the verifier requires
   * that choice to be offered by every authorized entry, so
   * `buildAuthorizationRequest` gives its appended request-binding entry the
   * intersection of what the caller offered rather than a hard-coded
   * `sha-256` — a caller asking for `sha-384` gets a request a conforming
   * wallet can actually satisfy. Callers whose own entries offer disjoint sets
   * are refused at construction, where nobody has consented to anything yet.
   */
  hashAlgorithms: ["sha-256", "sha-384", "sha-512"],
  /** §5.9.3 prefixes this package will build a request under. */
  clientIdPrefixes: ["redirect_uri", "x509_san_dns", "x509_hash"],
  /** §A.1 exchange protocol values emitted for the DC API. */
  digitalCredentialsProtocols: ["openid4vp-v1-unsigned"],
  implemented: [
    "authorization request construction with nonce, state, DCQL and transaction_data",
    "signed Request Objects (JAR, RFC 9101) with typ oauth-authz-req+jwt",
    "W3C Digital Credentials API request projection",
    "single-use request sessions with atomic compare-and-set consumption",
    "SD-JWT+KB parsing, disclosure digests and claim reconstruction",
    "issuer signature verification against a configured trusted JWK allow-list",
    "cryptographic holder binding: cnf.jwk, KB-JWT signature, sd_hash, freshness",
    "nonce and audience binding, compared in constant time, and re-compared after the KB-JWT signature verifies",
    "response-mode binding, taken from the transport and compared by value: the observed mode is not a secret and there is nothing in it to leak",
    "caller-supplied response fields and tolerances re-validated before use, so a forwarded request body cannot raise a foreign error",
    "transaction_data_hashes set equality, order independent",
    "OpenSesame request-digest binding carried inside signed transaction data",
  ],
  notSupported: [
    {
      feature: "mso_mdoc credentials",
      reason:
        "verifying one needs CBOR, COSE_Sign1, an MSO, DeviceAuth over a SessionTranscript whose construction differs per invocation method, and an X.509 IACA chain. The format identifier is recognized so a response carrying it is refused by name rather than by a default branch.",
    },
    {
      feature: "encrypted responses (direct_post.jwt, dc_api.jwt)",
      reason:
        "no JWE decryption. Requesting a mode whose response cannot be read would waste a real user's consent, so those modes cannot be built either.",
    },
    {
      feature: "W3C VC data-model formats (jwt_vc_json, ldp_vc, SD-JWT VCLD)",
      reason:
        "each is a separate proof stack; JSON-LD canonicalization in particular is a security-relevant dependency this package will not take on.",
    },
    {
      feature: "presentations without cryptographic holder binding",
      reason:
        "§14.1.1 states plainly that they provide no replay protection. This verifier exists to bind a proof to an authorization request, which is exactly what such a presentation cannot do.",
    },
    {
      feature: "multiple Credential Queries, credential_sets, multiple:true",
      reason:
        "one response would then carry several independent trust conclusions and VerifiedPresentation describes one. Requests with more than one Credential Query are refused at construction rather than reduced.",
    },
    {
      feature: "DCQL claim and claim_sets matching",
      reason:
        "only format and meta.vct_values are re-checked against the returned credential. Callers must check that the claims they need are present in VerifiedPresentation.claims.",
    },
    {
      feature:
        "openid_federation, decentralized_identifier and verifier_attestation client id prefixes",
      reason:
        "each requires the verifier to hold a key inside a trust infrastructure (federation trust chains, DID resolution, an attestation issuer) that does not belong in a protocol library.",
    },
    {
      feature:
        "signed and multi-signed DC API requests (openid4vp-v1-signed, -multisigned)",
      reason:
        "they require expected_origins plus a trust framework mapping client identifiers to origins; unsigned DC API requests rely on the browser-authenticated origin instead.",
    },
    {
      feature:
        "scope-based presentation requests, request_uri_method post, verifier_info",
      reason:
        "not implemented; nothing in this package emits or consumes them.",
    },
    {
      feature: "credential status, revocation and trusted_authorities",
      reason:
        "revocation is a deployment-owned lookup with its own freshness policy. This package reports issuer, vct and validity window so a caller can run one; it does not pretend to have run it.",
    },
    {
      feature: "wallets without transaction_data support",
      reason:
        "every request carries an opensesame_request_binding entry so the request digest is inside the holder's signature. §8.4 requires a wallet that cannot process transaction_data to reject such a request.",
    },
  ],
} as const;
