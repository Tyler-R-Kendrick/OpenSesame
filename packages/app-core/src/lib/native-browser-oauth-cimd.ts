/** CIMD is a real public registration contract, checked against deployment and issuer metadata. */
import { z } from "zod";
import { nativeApiHttp } from "./native-api-http.js";
import {
  browserOAuthEndpoints,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import type { NativeConfiguration } from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { nativeOAuthRedirectUri } from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";

const Metadata = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  token_endpoint_auth_methods_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  client_id_metadata_document_supported: z.literal(true),
  revocation_endpoint: z.string().url().optional(),
});
const Client = z.object({
  client_id: z.string().url(),
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.string().url()),
  token_endpoint_auth_method: z.literal("none"),
  client_secret: z.never().optional(),
  jwks: z.never().optional(),
  jwks_uri: z.never().optional(),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
});
export function nativeBrowserOAuthClientMetadataUrl(
  redirectUri = nativeOAuthRedirectUri(),
): string {
  const callback = new URL(redirectUri);
  if (
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  )
    throw new Error(
      "CIMD authorization requires a public HTTPS deployment with its registered callback",
    );
  return new URL("native-client.json", callback).href;
}
export async function verifyNativeBrowserCimd(
  configuration: NativeConfiguration,
  redirectUri: string,
  transport: NativeProviderTransport,
): Promise<void> {
  const profile = requiredBrowserOAuthProfile(configuration.providerId);
  if (profile.mode !== "cimd") return;
  const expectedClient = nativeBrowserOAuthClientMetadataUrl(redirectUri);
  if (configuration.clientId !== expectedClient)
    throw new NativeOAuthError("provider");
  const endpoints = browserOAuthEndpoints(profile, configuration);
  const discovery = `${endpoints.issuer}/.well-known/oauth-authorization-server`;
  const headers = new Headers({ accept: "application/json" });
  try {
    const metadata = Metadata.parse(
      await nativeApiHttp(
        { url: discovery, method: "GET", headers },
        transport,
      ),
    );
    if (
      metadata.issuer !== endpoints.issuer ||
      metadata.authorization_endpoint !== endpoints.authorization ||
      metadata.token_endpoint !== endpoints.token ||
      !metadata.token_endpoint_auth_methods_supported.includes("none") ||
      !metadata.code_challenge_methods_supported.includes("S256")
    )
      throw new NativeOAuthError("provider");
    const client = Client.parse(
      await nativeApiHttp(
        { url: expectedClient, method: "GET", headers },
        transport,
      ),
    );
    if (
      client.client_id !== expectedClient ||
      !client.redirect_uris.includes(redirectUri) ||
      !client.grant_types.includes("authorization_code") ||
      !client.response_types.includes("code")
    )
      throw new NativeOAuthError("provider");
  } catch {
    throw new NativeOAuthError("provider");
  }
}
