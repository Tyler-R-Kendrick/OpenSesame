/**
 * `@opensesame/openid4vci` — the smallest legitimate issuer for an
 * OpenSesame-owned digital credential.
 *
 * The flow, end to end, is five calls:
 *
 * 1. {@link buildIssuerMetadata} publishes what we support.
 * 2. {@link createCredentialOffer} mints a single-use pre-authorized code and
 *    a link that carries only a reference to it.
 * 3. {@link MemoryPreAuthorizedCodeStore.redeem} spends that code once.
 * 4. {@link NonceStore.issue} hands the wallet a challenge;
 *    {@link verifyProofOfPossession} checks the key proof built around it and
 *    returns the holder's key.
 * 5. {@link issueCredential} signs an SD-JWT VC bound to that key.
 *
 * Read `issue.ts`'s header first if you are here to find out what the
 * credential means. The short version is that it means as little as it
 * possibly can: an opaque subject reference proved by a holder key, and no
 * authorization of any kind. Runtime authority stays server-side.
 *
 * {@link SUPPORT_MATRIX} is the honest inventory — including the parts of
 * OpenID4VCI this package deliberately does not implement, and the fact that
 * the credential format profile is still an Internet-Draft.
 */

export {
  Openid4vciError,
  type Openid4vciErrorCode,
  type Openid4vciWireError,
} from "./errors.js";

export {
  CREDENTIAL_FORMAT,
  CREDENTIAL_ISSUER_WELL_KNOWN,
  SUPPORTED_ALGORITHMS,
  type CredentialDisplay,
  type CredentialIssuerIdentifier,
  type IssuerMetadata,
  type IssuerMetadataConfig,
  type SupportedAlgorithm,
  buildIssuerMetadata,
  isSupportedAlgorithm,
  issuerMetadataUrl,
  parseCredentialIssuer,
} from "./metadata.js";

export {
  CREDENTIAL_OFFER_SCHEME,
  DEFAULT_PRE_AUTHORIZED_CODE_TTL_SECONDS,
  MemoryPreAuthorizedCodeStore,
  PRE_AUTHORIZED_CODE_GRANT_TYPE,
  type CreatedCredentialOffer,
  type CredentialOfferInput,
  type PreAuthorizedCodeStore,
  type PreAuthorizedGrant,
  type RedeemedGrant,
  type TransactionCodeInputMode,
  type TransactionCodeSpec,
  assertOfferLinkIsClean,
  createCredentialOffer,
} from "./offer.js";

export {
  DEFAULT_NONCE_TTL_SECONDS,
  MemoryNonceStore,
  type IssuedNonce,
  type NonceStore,
} from "./nonce.js";

export {
  DEFAULT_PROOF_CLOCK_SKEW_SECONDS,
  DEFAULT_PROOF_MAX_AGE_SECONDS,
  PROOF_JWT_TYP,
  type ProofExpectations,
  type VerifiedProof,
  verifyProofOfPossession,
} from "./proof.js";

export {
  FORBIDDEN_CREDENTIAL_CLAIMS,
  SD_ALG,
  SD_JWT_VC_MEDIA_TYPE,
  SD_JWT_VC_TYP,
  type DeviceRef,
  type IssueCredentialInput,
  type IssuedCredential,
  type IssuedDisclosure,
  type PairwiseRef,
  type PairwiseRefInput,
  type SubjectRef,
  deriveDeviceRef,
  deriveSubjectRef,
  issueCredential,
} from "./issue.js";

/**
 * What this package implements, and — more usefully — what it does not.
 *
 * Written to be quoted verbatim in documentation, so it states the specific
 * revision of every specification it was built against and marks the one that
 * is not final. An issuer that reports "OpenID4VCI compliant" without saying
 * which grants and formats it omitted is not telling anyone anything.
 *
 * The `notSupported` list is the interesting half. Each entry is a decision,
 * not a gap waiting to be filled, and the reason is given so that a future
 * contributor can tell "we chose not to" from "nobody got to it".
 */
export const SUPPORT_MATRIX = {
  specifications: {
    /** Final specification, approved by the OpenID Foundation. */
    openid4vci: {
      title: "OpenID for Verifiable Credential Issuance 1.0",
      version: "1.0",
      date: "2025-09-16",
      status: "final",
      url: "https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0-final.html",
    },
    /** The selective-disclosure mechanism. An IETF Standards Track RFC. */
    sdJwt: {
      title: "Selective Disclosure for JSON Web Tokens (SD-JWT)",
      version: "RFC 9901",
      date: "2025-11-19",
      status: "final",
      url: "https://www.rfc-editor.org/rfc/rfc9901.html",
    },
    /**
     * The credential profile. **Still an Internet-Draft.**
     *
     * `dc+sd-jwt` and the `vct` claim come from here, and the document is in
     * IESG processing ("AD Evaluation::AD Followup") rather than published. The
     * wire format has been stable since the `vc+sd-jwt` → `dc+sd-jwt` rename in
     * November 2024, but "stable" is not "final": a further revision can still
     * change what we emit, and anything built on this package should expect a
     * format bump rather than assume one cannot happen.
     *
     * The revision is a pin, not a "latest" pointer — later revisions exist and
     * this package has not been read against them. `@opensesame/openid4vp`'s
     * matrix pins the same one: the issuer and the verifier are the two ends of
     * one credential, so a matrix that let them drift apart would document an
     * interoperability question as if it were two independent answers.
     */
    sdJwtVc: {
      title: "SD-JWT-based Verifiable Digital Credentials (SD-JWT VC)",
      version: "draft-ietf-oauth-sd-jwt-vc-18",
      date: "2026-08-03",
      status: "internet-draft",
      url: "https://datatracker.ietf.org/doc/html/draft-ietf-oauth-sd-jwt-vc-18",
    },
    /**
     * Consulted, not claimed. See `notSupported.haipConformance`.
     */
    haip: {
      title: "OpenID4VC High Assurance Interoperability Profile 1.0",
      version: "1.0",
      date: "2025-12",
      status: "final",
      url: "https://openid.net/specs/openid4vc-high-assurance-interoperability-profile-1_0.html",
    },
  },

  issuerMetadata: {
    wellKnownPath: "/.well-known/openid-credential-issuer",
    /** Published. Its presence makes `nonce` mandatory in every key proof. */
    nonceEndpoint: true,
    signedMetadata: false,
  },

  grantTypes: ["urn:ietf:params:oauth:grant-type:pre-authorized_code"],
  /** `tx_code` is supported, including the constant-time comparison it needs. */
  transactionCode: true,

  credentialOffer: {
    /** Only by reference. The by-value form is refused, not merely unused. */
    byReference: true,
    byValue: false,
    scheme: "openid-credential-offer://",
  },

  proofTypes: ["jwt"],
  proofJwtTyp: "openid4vci-proof+jwt",
  /** Signing and key-proof algorithms. Identical list on both sides. */
  algorithms: ["ES256", "EdDSA"],

  credentialFormat: {
    identifier: "dc+sd-jwt",
    mediaType: "application/dc+sd-jwt",
    issuerJwtTyp: "dc+sd-jwt",
    sdAlg: "sha-256",
    cryptographicBindingMethods: ["jwk"],
  },

  /**
   * Everything below is absent on purpose.
   */
  notSupported: {
    authorizationCodeGrant:
      "No Authorization Code flow, no PAR, no scopes, no authorization_details. " +
      "This issuer is reached from an offer minted by an already-authenticated " +
      "OpenSesame session, so a second OAuth dance would add a redirect surface " +
      "and a scope vocabulary to a credential that is deliberately not an " +
      "authorization.",
    deferredIssuance:
      "No transaction_id, no Deferred Credential Endpoint. The credential is " +
      "a signature over data we already hold; there is nothing to wait for, and " +
      "a deferred path would add a second identifier that outlives the request.",
    batchIssuance:
      "No batch_credential_issuance metadata, and verifyProofOfPossession " +
      "takes exactly one key proof: a Credential Request carrying several in " +
      "its proofs array gets no help here. Batch issuance exists to give a " +
      "wallet many single-use credentials for unlinkability, which is worth " +
      "having and is a different design (a per-credential subject salt, see " +
      "PairwiseRefInput.audience) rather than a loop around this one.",
    statusList:
      "No status claim, no Status List Token. Revocation by status list is a " +
      "third-party observable of every presentation unless deployed carefully, " +
      "and short credential lifetimes are the mitigation this profile uses " +
      "instead. A deployment needing revocation must add it deliberately.",
    mdoc: "No ISO/IEC 18013-5 mdoc, no CBOR, no COSE. One format, one parser.",
    jwtVcJson: "No jwt_vc_json or ldp_vc. Neither offers selective disclosure.",
    keyAttestation:
      "No key_attestation header, no attestation proof type. Both assert " +
      "properties of a key's storage that only a trusted wallet attestation " +
      "can establish, and this issuer has no such trust anchor to check them " +
      "against. Accepting one unchecked would be worse than not accepting it.",
    credentialResponseEncryption:
      "No credential_request_encryption or credential_response_encryption. " +
      "TLS is required; encryption on top of it protects against a compromised " +
      "TLS terminator, which is a deployment property rather than a library one.",
    notificationEndpoint: "No notification_endpoint and no notification_id.",
    didBinding:
      "No did: binding methods. Resolving a DID document turns a signature " +
      "check into a network dependency.",
    x5cAndKidProofs:
      "A key proof must carry jwk. kid and x5c are refused: both mean trusting " +
      "something outside the token, and this issuer has no holder key registry " +
      "or certificate anchor.",
    issClaimInProofs:
      "A key proof carrying iss is refused. Appendix F.1 requires it omitted " +
      "for anonymous pre-authorized code issuance, which is the only flow here.",
    haipConformance:
      "Not HAIP 1.0 conformant, and does not claim to be. HAIP requires the " +
      "Authorization Code flow and wallet key attestations, both of which are " +
      "listed above as deliberate omissions. The HAIP requirements this package " +
      "does meet are the format identifier (dc+sd-jwt) and ES256/P-256 support.",
  },
} as const;
