/** Select only a published provider resource; free-form servers are a separate product. */
import { type McpInfo, connectPlan } from "./connect-plan.js";
import type {
  NativeConfiguration,
  NativeFieldClassification,
} from "./native-connector-schema.js";
import type { NativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import { validateNativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import {
  type NativeMcpBinding,
  NativeMcpError,
  validateNativeMcpBinding,
} from "./native-mcp-target.js";
import {
  type NativeOAuthBrowserPort,
  nativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";

export const MCP_CLASSIFICATION: NativeFieldClassification = {
  publicParameters: ["mcp_url"],
  privateCredentials: ["mcp_client"],
};
export function nativeMcpClassification(
  _configuration: NativeConfiguration,
): NativeFieldClassification {
  return MCP_CLASSIFICATION;
}

export function nativeMcpProviderMetadata(
  providerId: string,
  selected?: string,
): McpInfo {
  const plan = connectPlan(providerId);
  if (!plan || plan.refused) throw new NativeMcpError("target");
  const candidates = plan.methods.filter((method) => method.kind === "mcp");
  const candidate = selected
    ? candidates.find((method) => method.mcp.url === selected)
    : candidates[0];
  if (!candidate) throw new NativeMcpError("target");
  return structuredClone(candidate.mcp);
}

export function nativeMcpRecordBinding(
  configuration: NativeConfiguration,
): NativeMcpBinding {
  const metadata = nativeMcpProviderMetadata(
    configuration.providerId,
    configuration.parameters.mcp_url,
  );
  const binding: NativeMcpBinding = {
    providerId: configuration.providerId,
    fingerprint: configuration.fingerprint,
    endpoint: metadata.url,
    resource:
      metadata.status === "ok"
        ? (metadata.resource ?? metadata.url)
        : metadata.url,
    issuer: metadata.status === "ok" ? metadata.issuer : null,
    transport: new URL(metadata.url).pathname.endsWith("/sse")
      ? "sse"
      : "streamable-http",
  };
  validateNativeMcpBinding(binding);
  return binding;
}

export async function nativeMcpConfigurationFingerprint(
  configuration: Omit<NativeConfiguration, "fingerprint">,
): Promise<string> {
  const metadata = nativeMcpProviderMetadata(
    configuration.providerId,
    configuration.parameters.mcp_url,
  );
  const material = JSON.stringify({
    providerId: configuration.providerId,
    method: "mcp",
    metadata,
    clientId: configuration.clientId ?? null,
    requestedScopes: configuration.requestedScopes,
    targetIds: configuration.targetIds,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function nativeMcpRecordOAuthTarget(
  configuration: NativeConfiguration,
  browser: NativeOAuthBrowserPort = nativeOAuthBrowserPort(),
): NativeMcpOAuthTarget {
  const metadata = nativeMcpProviderMetadata(
    configuration.providerId,
    configuration.parameters.mcp_url,
  );
  if (metadata.status !== "ok") throw new NativeMcpError("authorization");
  const target: NativeMcpOAuthTarget = {
    binding: nativeMcpRecordBinding(configuration),
    metadata,
    redirectUri: browser.redirectUri,
    registration: metadata.registration,
    clientId: configuration.clientId,
    clientMetadataUrl:
      metadata.registration === "cimd"
        ? new URL("native-client.json", browser.redirectUri).href
        : undefined,
    scopes: configuration.requestedScopes.user ?? [],
  };
  validateNativeMcpOAuthTarget(target);
  return target;
}
