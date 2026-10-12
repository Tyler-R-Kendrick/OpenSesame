import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { NativeGrant, NativePending } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
} from "./native-connector-store.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { nativeMcpConfigurationFingerprint } from "./native-mcp-profile.js";
import { NativeMcpError } from "./native-mcp-target.js";

import {
  type NativeMcpRegisteredClient,
  NativeMcpRegistrationReceiptSchema,
} from "./native-mcp-registration-receipt.js";

export function requireNativeMcpRecord(id: string): NativeConnectorRecord {
  const record = loadNativeConnectorRecord(id);
  if (!record || record.configuration.method !== "mcp")
    throw new NativeMcpError("target");
  return record;
}
export async function assertNativeMcpContract(
  record: NativeConnectorRecord,
): Promise<void> {
  if (
    record.configuration.fingerprint !==
    (await nativeMcpConfigurationFingerprint(record.configuration))
  )
    throw new NativeMcpError("target");
}
export function nativeMcpClient(
  record: NativeConnectorRecord,
): NativeMcpRegisteredClient {
  try {
    return NativeMcpRegistrationReceiptSchema.parse(
      JSON.parse(record.privateState.credentials.mcp_client ?? ""),
    );
  } catch {
    throw new NativeMcpAuthError("public-client");
  }
}
export function nativeMcpIssuedGrant(
  pending: Pick<
    NativePending,
    | "providerId"
    | "actor"
    | "fingerprint"
    | "targetId"
    | "issuer"
    | "resource"
    | "endpoint"
    | "clientId"
  >,
  tokens: OAuthTokens,
): NativeGrant {
  const grant: NativeGrant = {
    providerId: pending.providerId,
    actor: pending.actor,
    fingerprint: pending.fingerprint,
    targetId: pending.targetId,
    issuer: pending.issuer,
    resource: pending.resource,
    endpoint: pending.endpoint,
    clientId: pending.clientId,
    kind: "mcp",
    accessToken: tokens.access_token,
    expiresAt:
      tokens.expires_in === undefined
        ? null
        : Date.now() + tokens.expires_in * 1000,
    scopes:
      tokens.scope === undefined
        ? null
        : [...new Set(tokens.scope.split(/\s+/).filter(Boolean))],
  };
  if (tokens.refresh_token) grant.refreshToken = tokens.refresh_token;
  return grant;
}
