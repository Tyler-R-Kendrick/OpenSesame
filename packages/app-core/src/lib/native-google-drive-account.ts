import type { NativeConfiguration } from "./native-connector-schema.js";
import { GOOGLE_ACCOUNT_POLICY } from "./native-google-account-policy.generated.js";
import { NativeOAuthError } from "./native-oauth-errors.js";

export function normalizeGoogleDriveAccountScopes(
  providerId: string,
  scopes: readonly string[] | null,
): string[] | null {
  if (providerId !== "google-drive" || scopes === null)
    return scopes === null ? null : [...scopes];
  return scopes.map((scope) => {
    const alias = Object.entries(GOOGLE_ACCOUNT_POLICY.aliases).find(
      ([name]) => name === scope,
    );
    return alias?.[1] ?? scope;
  });
}

export function isGoogleDriveAccountScopeSet(
  providerId: string,
  scopes: readonly string[] | null,
): boolean {
  const normalized = normalizeGoogleDriveAccountScopes(providerId, scopes);
  return (
    providerId !== "google-drive" ||
    normalized === null ||
    (normalized.length === GOOGLE_ACCOUNT_POLICY.scopes.length &&
      GOOGLE_ACCOUNT_POLICY.scopes.every((scope) => normalized.includes(scope)))
  );
}

export function assertGoogleDriveAccountScopes(
  providerId: string,
  scopes: readonly string[] | null,
): void {
  if (!isGoogleDriveAccountScopeSet(providerId, scopes))
    throw new NativeOAuthError("scope");
}

export function assertGoogleDriveAccountContract(
  configuration: NativeConfiguration,
): void {
  if (configuration.providerId !== "google-drive") return;
  const scopes = configuration.requestedScopes.user ?? [];
  if (
    configuration.method !== "oauth" ||
    Object.keys(configuration.requestedScopes).some(
      (actor) => actor !== "user",
    ) ||
    Object.entries(GOOGLE_ACCOUNT_POLICY.endpoints).some(
      ([key, endpoint]) => configuration.parameters[key] !== endpoint,
    ) ||
    GOOGLE_ACCOUNT_POLICY.forbiddenParameters.some(
      (key) => configuration.parameters[key] !== undefined,
    )
  )
    throw new NativeOAuthError("scope");
  assertGoogleDriveAccountScopes(configuration.providerId, scopes);
}
