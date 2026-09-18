/**
 * Documented maximum lifetime for the supported unattended JWT profile
 * (ADV-19). Online introspection can revoke sooner; an independent RP that
 * accepts the JWT offline can keep using it until this bound.
 */
export const SERVICE_ACCESS_TOKEN_MAX_SECONDS = 3600;

export function offlineJwtExposureBoundSeconds(): number {
  return SERVICE_ACCESS_TOKEN_MAX_SECONDS;
}
