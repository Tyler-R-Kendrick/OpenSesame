export type {
  ClientAdmissionMode,
  ClientState,
  OAuthClientRecord,
  OAuthProviderEnv,
  OwnershipStatus,
  PairwiseSubject,
  PairwiseSubjectStore,
  SectorKeyRelease,
} from "./types.js";
export { ORIGIN_PROFILE_FORBIDDEN_SCOPES } from "./types.js";
export { readOAuthProviderEnv } from "./env.js";
export {
  canonicalResource,
  createOpenSesameProvider,
  isPkceRequired,
  isResourceAllowed,
  type CreateOpenSesameProviderOptions,
  type OpenSesameProviderBundle,
} from "./create-provider.js";
export { createLoadExistingGrant } from "./consent/load-existing-grant.js";
export {
  previewAccountClaims,
  projectAccountClaims,
  ReservedClaimError,
  RESERVED_PROTOCOL_CLAIMS,
  type AccountPrincipal,
  type ClaimMapping,
  type ProjectAccountClaimsInput,
} from "./claims/project-account-claims.js";
export {
  createFindAccount,
  type AccountLookup,
  type FindAccountOptions,
  type LookupAccount,
  type MapClaims,
} from "./claims/find-account.js";
export { ReplayCache, type JwtReplayCache } from "./grants/replay-cache.js";
export {
  CLIENT_CREDENTIALS_FEATURE,
  SERVICE_ACCESS_TOKEN_MAX_SECONDS,
  assertConfidentialClientCredentials,
  isPublicClient,
} from "./grants/client-credentials.js";
export { createMemoryAdapterConstructor } from "./adapter/memory-adapter.js";
export {
  createPostgresAdapterConstructor,
  type PostgresOidcStore,
  type OidcAdapter,
  type OidcAdapterConstructor,
  type OidcAdapterPayload,
} from "./adapter/types.js";
export {
  MemoryPairwiseSubjectStore,
  createPairwiseIdentifierCallback,
  type PairwiseClientLookup,
} from "./pairwise/store.js";
export {
  canonicalSectorIdentifier,
  pairwiseSectorKey,
  pairwiseSubjectSector,
  sectorIdentifierSpellings,
} from "./pairwise/sector.js";
export {
  ClientAdmissionError,
  createClientAdmissionPolicy,
  defaultAdmissionFromEnv,
  type ClientAdmissionPolicy,
} from "./clients/admission.js";
export {
  type ClientRecordStore,
  type InsertOptions,
  MemoryClientRecordStore,
  SectorKeyClaimedError,
} from "./clients/store.js";
export {
  findOriginClient,
  type ResolveOriginClientOptions,
  resolveOriginClient,
  toOidcClientMetadata,
} from "./clients/origin-resolve.js";
export {
  type CanonicalizeOriginOptions,
  canonicalizeOrigin,
  defaultCallbackUri,
  OriginError,
  type OriginErrorCode,
  originClientId,
  parseOriginClientId,
} from "./origin/canonical.js";
export {
  evaluateTokenCors,
  type TokenCorsDecision,
} from "./cors/token-cors.js";
export {
  SafeMetadataFetcher,
  UnsafeMetadataUrlError,
  assertSafeMetadataUrl,
} from "./metadata/safe-fetcher.js";
export { EnvSigningKeyProvider } from "./keys/dev-signing-key-provider.js";
export {
  buildMtlsFeature,
  certificateSubjectMatches,
  combineExtraClientMetadata,
  mtlsClientAuthMethods,
  mtlsClientFence,
  mtlsDiscovery,
  type MtlsPeer,
  type MtlsTransport,
} from "./mtls/feature.js";
