import {
  isGoogleDriveAccountScopeSet,
  normalizeGoogleDriveAccountScopes,
} from "./native-google-drive-account.js";

export function offlineConsentValid(
  requested: readonly string[],
  issued: readonly string[] | null,
  refreshToken: string | undefined,
): boolean {
  return (
    !requested.includes("offline_access") ||
    issued?.includes("offline_access") === true ||
    refreshToken !== undefined
  );
}

export function requiredResourceScopes(
  requested: readonly string[],
): readonly string[] {
  return requested.filter((scope) => scope !== "offline_access");
}

/** Compare equivalent provider scope spellings without broadening the requested set. */
export function hasRequiredResourceScopes(
  providerId: string,
  requested: readonly string[],
  granted: readonly string[],
): boolean {
  const required =
    normalizeGoogleDriveAccountScopes(
      providerId,
      requiredResourceScopes(requested),
    ) ?? [];
  const issued = normalizeGoogleDriveAccountScopes(providerId, granted) ?? [];
  return required.every((scope) => issued.includes(scope));
}

/** Require account-only Google grants and all known requested resource scopes. */
export function admissibleGrantScopes(
  providerId: string,
  requested: readonly string[],
  granted: readonly string[] | null,
): boolean {
  return (
    isGoogleDriveAccountScopeSet(providerId, granted) &&
    (granted === null ||
      hasRequiredResourceScopes(providerId, requested, granted))
  );
}
