/**
 * Native DCR/remote JWKS fetches bypass SafeMetadataFetcher. Use the same
 * 64 KiB budget via oidc-provider's header and streamed-byte enforcement.
 * Keep other native defaults (including the CIMD limit) inherited.
 */
export const FETCH_RESPONSE_BODY_LIMITS = {
  sector_identifier_uri: 64 * 1024,
  jwks_uri: 64 * 1024,
};
