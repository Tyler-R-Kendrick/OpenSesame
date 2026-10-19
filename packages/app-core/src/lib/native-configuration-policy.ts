/** Project public connection targets through one real captured runtime; metadata never grants transport. */
import {
  browserOAuthEndpoints,
  nativeBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import { nativeBrowserOAuthVerificationEndpoint } from "./native-browser-oauth-resources.js";
import { nativeBrowserMethodPolicy } from "./native-browser-policy.js";
import type { NativeConfiguration } from "./native-connector-schema.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { nativeMcpProviderMetadata } from "./native-mcp-profile.js";
function actualTargets(
  providerId: string,
  method: NativeConfiguration["method"],
  parameters: Readonly<Record<string, string>>,
) {
  if (method === "oauth") {
    if ("token_endpoint" in parameters || "resource" in parameters)
      return parameters.token_endpoint && parameters.resource
        ? {
            tokenEndpoint: parameters.token_endpoint,
            resourceEndpoint: parameters.resource,
          }
        : null;
    const profile = nativeBrowserOAuthProfile(providerId);
    const resource = nativeBrowserOAuthVerificationEndpoint(providerId);
    return profile && resource
      ? {
          tokenEndpoint: browserOAuthEndpoints(profile, {
            parameters: { ...parameters },
          }).token,
          resourceEndpoint: resource,
        }
      : null;
  }
  if (method === "mcp") {
    const metadata = nativeMcpProviderMetadata(providerId, parameters.mcp_url);
    return metadata.status === "ok"
      ? {
          tokenEndpoint: metadata.tokenEndpoint,
          resourceEndpoint: metadata.url,
        }
      : null;
  }
  return null;
}
export function nativeConfigurationBrowserPolicy(
  providerId: string,
  method: NativeConfiguration["method"],
  parameters: Readonly<Record<string, string>> = {},
  supplied?: NativeProviderTransport,
) {
  const direct = nativeBrowserMethodPolicy(providerId, method, parameters);
  if (direct.available) return direct;
  try {
    const targets = actualTargets(providerId, method, parameters);
    if (!targets) return direct;
    const transport = supplied ?? nativeProviderTransport();
    return nativeBrowserMethodPolicy(providerId, method, parameters, {
      ...targets,
      transport,
    });
  } catch {
    return direct;
  }
}
/** Executable owners pass their original captured transport; no ambient capture or fallback is used. */
export function assertNativeConfigurationPolicy(
  configuration: NativeConfiguration,
  transport: NativeProviderTransport,
): void {
  const decision = nativeConfigurationBrowserPolicy(
    configuration.providerId,
    configuration.method,
    configuration.parameters,
    transport,
  );
  if (!decision.available)
    throw new Error(
      `${decision.reason ? `${decision.reason} ` : ""}Configure the Tailscale browser node's integration HTTP transport for this connection's token and resource origins, or use an endpoint that permits this browser origin.`,
    );
  transport.assertCurrent();
  transport.signal?.throwIfAborted();
}
