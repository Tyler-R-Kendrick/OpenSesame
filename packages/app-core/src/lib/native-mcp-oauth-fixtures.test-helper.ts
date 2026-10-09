import type { JsonObject } from "@opensesame/os-domain";
import { expect, vi } from "vitest";
import type { NativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import {
  type NativeMcpOAuthPorts,
  NativeMcpPublicOAuth,
} from "./native-mcp-oauth.js";

export const target: NativeMcpOAuthTarget = {
  binding: {
    providerId: "adobe",
    fingerprint: "sealed-target",
    endpoint: "https://express-mcp-service.adobe.io/mcp",
    resource: "https://express-mcp-service.adobe.io/mcp",
    issuer: "https://express-mcp-service.adobe.io",
    transport: "streamable-http",
  },
  metadata: {
    status: "ok",
    url: "https://express-mcp-service.adobe.io/mcp",
    issuer: "https://express-mcp-service.adobe.io",
    authorizationEndpoint: "https://express-mcp-service.adobe.io/authorize",
    tokenEndpoint: "https://ims-na1.adobelogin.com/ims/token/v3",
    registration: "dcr",
    pkce: ["S256"],
    scopes: ["openid", "AdobeID"],
    resource: "https://express-mcp-service.adobe.io/mcp",
    resourceMetadata:
      "https://express-mcp-service.adobe.io/.well-known/oauth-protected-resource",
    discoveryUrl:
      "https://express-mcp-service.adobe.io/.well-known/oauth-authorization-server",
    registrationEndpoint: "https://express-mcp-service.adobe.io/register",
    revocationEndpoint: "https://ims-na1.adobelogin.com/ims/revoke",
    tokenAuthMethods: ["none"],
  },
  redirectUri: "https://self-host.example.org/auth/native-connector.html",
  registration: "dcr",
  scopes: ["openid"],
};
export const state = "sealed-state-with-at-least-256-bits-of-randomness";
export const client = {
  client_id: "actual-public-client",
  issuer: target.binding.issuer ?? "",
};
export const verifier = "saved-verifier-with-more-than-forty-three-characters";
type FixtureOptions = {
  resource?: JsonObject;
  live?: JsonObject;
  registered?: JsonObject;
  document?: JsonObject;
  tokenFailure?: boolean;
  token?: JsonObject;
  onToken?: () => void;
  assertCurrent?: () => void;
  settle?: boolean;
};

export function fixture(selected = target, options: FixtureOptions = {}) {
  const requests: Request[] = [];
  const response = (body: JsonObject, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const ports: NativeMcpOAuthPorts = {
    signal: new AbortController().signal,
    assertCurrent: options.assertCurrent ?? (() => undefined),
    fetch: vi.fn(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      expect(request.credentials).toBe("omit");
      expect(request.redirect).toBe("manual");
      expect(request.headers.has("authorization")).toBe(false);
      if (request.url === selected.metadata.resourceMetadata)
        return response(
          options.resource ?? {
            resource: selected.binding.resource,
            authorization_servers: [selected.binding.issuer],
          },
        );
      if (request.url === selected.metadata.discoveryUrl)
        return response({
          issuer: selected.binding.issuer,
          authorization_endpoint: selected.metadata.authorizationEndpoint,
          token_endpoint: selected.metadata.tokenEndpoint,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          registration_endpoint: selected.metadata.registrationEndpoint,
          client_id_metadata_document_supported: true,
          ...options.live,
        });
      if (request.url === selected.clientMetadataUrl)
        return response(
          options.document ?? {
            client_id: selected.clientMetadataUrl ?? "",
            client_name: "OpenSesame",
            redirect_uris: [selected.redirectUri],
            token_endpoint_auth_method: "none",
          },
        );
      if (request.url === selected.metadata.registrationEndpoint)
        return response(
          options.registered ?? {
            client_id: client.client_id,
            redirect_uris: [selected.redirectUri],
            token_endpoint_auth_method: "none",
          },
          201,
        );
      if (request.url === selected.metadata.revocationEndpoint)
        return new Response(null, { status: 200 });
      if (request.url === selected.metadata.tokenEndpoint) {
        options.onToken?.();
        if (options.tokenFailure)
          return response(
            {
              error: "invalid_grant",
              error_description: "private response detail must never reach UI",
            },
            400,
          );
        return response(
          options.token ?? {
            access_token: "issued-access",
            token_type: "Bearer",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
            scope: "openid",
          },
        );
      }
      throw new Error("Unexpected destination");
    }),
  };
  if (options.settle) ports.settleCredentialMutation = ports.fetch;
  return { ports, requests, oauth: new NativeMcpPublicOAuth(selected, ports) };
}
