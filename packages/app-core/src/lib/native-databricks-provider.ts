/** Public custom OAuth clients authorize against their registered Databricks workspace. */
import { z } from "zod";
import { nativeApiHttp } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";
import type {
  NativeConfiguration,
  NativePending,
  NativeRuntime,
} from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";

export function nativeDatabricksEndpoints(domain: string) {
  const suffixes = [
    ".cloud.databricks.com",
    ".azuredatabricks.net",
    ".gcp.databricks.com",
  ];
  if (
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) ||
    domain.includes("..") ||
    !suffixes.some(
      (suffix) => domain.endsWith(suffix) && domain.length > suffix.length,
    )
  )
    throw new NativeOAuthError("provider");
  const origin = `https://${domain}`;
  return {
    issuer: `${origin}/oidc`,
    authorization: `${origin}/oidc/v1/authorize`,
    token: `${origin}/oidc/v1/token`,
    resource: `${origin}/api/2.0/preview/scim/v2/Me`,
    settings: origin,
  };
}
export async function verifyNativeDatabricksIdentity(
  configuration: NativeConfiguration,
  pending: NativePending,
  token: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
): Promise<NonNullable<NativeRuntime["identity"]>> {
  const endpoints = nativeDatabricksEndpoints(
    configuration.parameters.domain ?? "",
  );
  if (
    configuration.providerId !== "databricks" ||
    pending.providerId !== "databricks" ||
    pending.endpoint !== endpoints.token ||
    pending.issuer !== endpoints.issuer
  )
    throw new NativeOAuthError("provider");
  const value = z
    .object({
      id: z.string().min(1).max(256),
      userName: z.string().min(1).max(1024),
      active: z.boolean(),
    })
    .parse(
      await nativeApiHttp(
        {
          url: endpoints.resource,
          method: "GET",
          headers: new Headers({
            accept: "application/json",
            authorization: `Bearer ${token.accessToken}`,
          }),
        },
        transport,
      ),
    );
  if (!value.active) throw new NativeOAuthError("expired");
  const secrets = {
    access: token.accessToken,
    refresh: token.refreshToken ?? "",
  };
  safeProviderText(value.id, secrets);
  safeProviderText(value.userName, secrets);
  return {
    id: value.id,
    label: value.userName,
    kind: "workspace-account",
    assurance: "account-verified",
  };
}
