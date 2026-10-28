import type { NativeConfiguration } from "./native-connector-schema.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthScopeIncludes } from "./native-oauth-scope-equivalence.js";

const ACCOUNT_SCOPES = ["openid", "email"] as const;
const ACCOUNT_ENDPOINTS = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  resource: "https://www.googleapis.com/oauth2/v3/userinfo",
} as const;
const DISALLOWED_PARAMETERS = [
  "token_relay_url",
  "resource_protocol",
  "mcp_endpoint",
  "mcp_transport",
  "mcp_post_endpoint",
] as const;

export function isGoogleDriveAccountScopeSet(
  providerId: string,
  scopes: readonly string[] | null,
): boolean {
  return (
    providerId !== "google-drive" ||
    scopes === null ||
    (scopes.every((scope) =>
      nativeOAuthScopeIncludes(providerId, ACCOUNT_SCOPES, scope),
    ) &&
      ACCOUNT_SCOPES.every((scope) =>
        nativeOAuthScopeIncludes(providerId, scopes, scope),
      ))
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
    Object.entries(ACCOUNT_ENDPOINTS).some(
      ([key, endpoint]) => configuration.parameters[key] !== endpoint,
    ) ||
    DISALLOWED_PARAMETERS.some(
      (key) => configuration.parameters[key] !== undefined,
    )
  )
    throw new NativeOAuthError("scope");
  assertGoogleDriveAccountScopes(configuration.providerId, scopes);
}
