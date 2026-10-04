/**
 * `@opensesame/siop-v2` — Self-Issued OpenID Provider v2 utilities.
 *
 * Read {@link SUPPORT_MATRIX} before citing this package anywhere.
 */

export {
  type SiopV2Checkpoint,
  type SiopV2ErrorCode,
  SiopV2Error,
  isSiopV2Error,
} from "./errors.js";

export {
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_ID_TOKEN_TTL_SECONDS,
  DEFAULT_MAX_IAT_AGE_SECONDS,
  MAX_AUTH_REQUEST_CHARS,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_FRAGMENT_RESPONSE_CHARS,
  MAX_ID_TOKEN_CHARS,
  MAX_ID_TOKEN_TTL_SECONDS,
  MAX_MAX_IAT_AGE_SECONDS,
} from "./limits.js";

export {
  type CheckedCompactJws,
  type SupportedSignatureAlgorithm,
  SUPPORTED_SIGNATURE_ALGORITHMS,
  isSupportedSignatureAlgorithm,
  readSignedCompactJws,
} from "./jose.js";

export {
  type EcP256PublicJwk,
  EC_P256_CRV,
  EC_P256_KTY,
  SUBJECT_SYNTAX_JWK_THUMBPRINT,
  ecP256JwkThumbprint,
  parsePublicEcP256Jwk,
} from "./jwk.js";

export {
  type AuthorizationRequestInput,
  type NormalizedAuthorizationRequest,
  type SupportedResponseMode,
  RESPONSE_MODE_FRAGMENT,
  RESPONSE_TYPE_ID_TOKEN,
  SCOPE_OPENID,
  parseAuthorizationRequest,
  serializeAuthorizationRequest,
} from "./request.js";

export {
  type BuildSelfIssuedIdTokenInput,
  type SiopIssuerProfile,
  type SigningKey,
  type VerifiedSelfIssuedIdToken,
  type VerifySelfIssuedIdTokenInput,
  STATIC_SELF_ISSUED_ISSUER,
  buildSelfIssuedIdToken,
  exportPublicEcP256Jwk,
  verifySelfIssuedIdToken,
} from "./id-token.js";

export {
  type ResolvedIssuer,
  assertAllowedIssuer,
  resolveIssuer,
  STATIC_SIOP_METADATA,
} from "./issuer.js";

export {
  type AcceptedSiopMetadata,
  type FetchSiopMetadataInput,
  type MetadataBodyReader,
  type MetadataFetch,
  type MetadataResponse,
  type SiopMetadataOptions,
  type PagesOrigin,
  type PagesSiopMetadata,
  DEFAULT_METADATA_TIMEOUT_MS,
  MAX_SIOP_METADATA_BYTES,
  PAGES_SIOP_EXTENSION,
  PAGES_SIOP_ISSUER_PATH,
  SIOP_DRAFT,
  SIOP_METADATA_FILE,
  buildPagesSiopMetadata,
  fetchSiopMetadata,
  pagesOriginOf,
  pagesSiopIssuer,
  parseSiopMetadata,
  serializePagesSiopMetadata,
  siopMetadataUrl,
} from "./discovery.js";

export {
  type CompleteSiopLoginInput,
  type SiopLoginResult,
  type SiopLoginStart,
  type SiopRelyingPartyConfig,
  type SiopRpErrorCode,
  type StartSiopLoginInput,
  SiopRelyingParty,
  SiopRpError,
  createSiopRelyingParty,
  generateLocalClientId,
} from "./rp.js";

export {
  type LoginStorage,
  type PendingSiopLogin,
  type SiopLoginStore,
  type SiopReplayLedger,
  DEFAULT_LOGIN_TTL_MS,
  DEFAULT_MAX_LEDGER_ENTRIES,
  DEFAULT_MAX_PENDING_LOGINS,
  DEFAULT_MAX_STORED_LOGINS,
  MemoryLoginStore,
  MemoryReplayLedger,
  StorageLoginStore,
  readLogin,
} from "./rp-store.js";

export { readAudience } from "./audience.js";

export {
  assertIAmSiopClaim,
  assertTokenFreshness,
  readEpoch,
} from "./validity.js";

export {
  type ResolveSiopLinkProfileInput,
  bodyOffersEmailJoin,
  challengeIssuerFromProfile,
  resolveSiopLinkProfile,
} from "./link-profile.js";

export {
  type FragmentErrorResponse,
  type FragmentResponse,
  type FragmentSuccessResponse,
  attachFragment,
  parseFragmentResponse,
  serializeFragmentError,
  serializeFragmentSuccess,
} from "./response.js";

export const SUPPORT_MATRIX = {
  specification: {
    name: "Self-Issued OpenID Provider v2",
    status: "Implementer's Draft 1",
    draft: "openid-connect-self-issued-v2-1_0-07",
    published: "2022-01-28",
    url: "https://openid.net/specs/openid-connect-self-issued-v2-1_0-ID1.html",
  },
  role: "Self-Issued OP + RP verifier utilities",
  subjectSyntaxTypes: ["urn:ietf:params:oauth:jwk-thumbprint"],
  signatureAlgorithms: ["ES256"],
  curves: ["P-256"],
  responseModes: ["fragment"],
  responseTypes: ["id_token"],
  scopes: ["openid"],
  issuerProfiles: {
    static: "https://self-issued.me/v2",
    dynamic:
      "HTTPS issuer with i_am_siop:true, or loopback HTTP (localhost, 127.0.0.1, [::1]) for dogfood",
  },
  implemented: [
    "strict authentication-request parse/normalize (client_id, redirect_uri, nonce, scope=openid, response_type=id_token)",
    "RFC 7638 JWK thumbprint for EC P-256 (canonical crv,kty,x,y)",
    "public sub_jwk validation that refuses private d, wrong kty/crv, and non-bare keys",
    "JOSE header fence refusing alg none and non-ES256 algorithms before signature verify",
    "Self-Issued ID Token builder via jose SignJWT with caller-supplied CryptoKey or JWK",
    "Self-Issued ID Token verifier via jose jwtVerify using only sub_jwk (never jwks_uri)",
    "static issuer profile https://self-issued.me/v2",
    "STATIC_SIOP_METADATA draft static Self-Issued OP document shape (openid: endpoint documented, not PWA-invoked)",
    "dynamic issuer profile with HTTPS iss (or loopback HTTP for local dogfood) and i_am_siop:true",
    "fragment response_mode serialize/parse helpers",
    "documented size and time limits with typed SiopV2Error refusals",
    "Pages deployment metadata: buildPagesSiopMetadata derives the published siop-metadata.json from STATIC_SIOP_METADATA (SIOP-shaped, not OIDC Discovery; no jwks_uri, no token_endpoint)",
    "metadata consumer: parseSiopMetadata / fetchSiopMetadata with an injected fetch, no redirects, a size bound, and the issuer pinned by the relying party",
    "relying-party kit: SiopRelyingParty binds a login to state, nonce, audience, issuer and redirect_uri, single-use state, token replay ledger, bounded stores",
  ],
  notSupported: [
    {
      feature:
        "openid: custom-scheme authorization endpoint as a PWA invocation mode",
      reason:
        "STATIC_SIOP_METADATA documents the draft static authorization_endpoint for RP interoperability, but this web PWA does not register an openid: handler. Same-device ceremony uses HTTPS /identity/siop.",
    },
    {
      feature: "Decentralized Identifier subject syntax (did:)",
      reason:
        "DID resolution and verificationMethod selection are a trust infrastructure this protocol library will not embed. Only urn:ietf:params:oauth:jwk-thumbprint is implemented.",
    },
    {
      feature: "response_mode=post (cross-device POST delivery)",
      reason:
        "cross-device delivery needs an RP endpoint, replay ledger, and transport policy outside this package. Only fragment (implicit default) is implemented.",
    },
    {
      feature:
        "signed request objects, request_uri, registration, registration_uri",
      reason:
        "JAR, federation entity statements, and dynamic RP registration each pull in trust frameworks this utility deliberately omits.",
    },
    {
      feature: "RSA / non-P-256 EC / EdDSA ID Token algorithms",
      reason:
        "ES256 on P-256 is the mandatory interoperability floor chosen here; widening the algorithm set widens the confusion surface.",
    },
    {
      feature: "jwks_uri or remote key discovery for ID Token verify",
      reason:
        "SIOPv2 JWK-thumbprint validation uses the bare key in sub_jwk. Fetching keys by URI would invent a trust path the profile does not grant.",
    },
    {
      feature: "OpenID4VP / VP Token presentation inside the SIOP response",
      reason:
        "credential presentation is owned by @opensesame/openid4vp; this package stops at the Self-Issued ID Token.",
    },
    {
      feature:
        "OpenID Connect Discovery (/.well-known/openid-configuration), token_endpoint and jwks_uri",
      reason:
        "a static origin has no back-channel to answer a token request and no per-person keys to list; the metadata a Pages deployment publishes is SIOP-shaped and says conventional_oidc:false (ADR 0161).",
    },
    {
      feature: "Dynamic relying-party registration for a Pages deployment",
      reason:
        "the person registers an application, its exact redirect_uri and scopes in their own vault before it can sign anyone in; there is no endpoint a relying party can register itself at (ADR 0106, ADR 0161).",
    },
  ],
} as const;
