import { isJsonObject, isString } from "@opensesame/os-domain";
import { endpointBelongsToIssuer } from "./federation-endpoint-origin.js";
import {
  type IdentityConnectionTest,
  identityEndpoint,
} from "./identity-connections-schema.js";
import { localNetworkFetch } from "./local-network-fetch.js";

/** Discovery proves a reachable standards endpoint; completing sign-in proves the registered client. */
export async function testIdentityOidc(
  issuer: string,
): Promise<IdentityConnectionTest> {
  const url = identityEndpoint(issuer);
  if (!url) throw new Error("Enter an HTTPS OpenID Connect issuer");
  const response = await localNetworkFetch(
    `${url}/.well-known/openid-configuration`,
    {
      credentials: "omit",
      timeoutMs: 8000,
    },
  );
  if (!response.ok)
    throw new Error(`OIDC discovery was refused (${response.status})`);
  const body = await response.json();
  if (
    !isJsonObject(body) ||
    !isString(body.issuer) ||
    body.issuer.replace(/\/+$/, "") !== url
  ) {
    throw new Error("OIDC discovery does not match the configured issuer");
  }
  for (const field of [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ] as const) {
    const endpoint = body[field];
    if (
      !isString(endpoint) ||
      !identityEndpoint(endpoint) ||
      !endpointBelongsToIssuer(endpoint, url)
    ) {
      throw new Error(`OIDC ${field} must belong to the configured issuer`);
    }
  }
  if (
    Array.isArray(body.response_types_supported) &&
    !body.response_types_supported.includes("code")
  ) {
    throw new Error(
      "This provider does not support the authorization code flow",
    );
  }
  if (
    Array.isArray(body.code_challenge_methods_supported) &&
    !body.code_challenge_methods_supported.includes("S256")
  ) {
    throw new Error("This provider does not support S256 PKCE");
  }
  return {
    message:
      "OpenID Connect discovery is reachable and matches the issuer. Complete sign-in to verify your client registration.",
  };
}
