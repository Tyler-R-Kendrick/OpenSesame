/** Adobe's compiled public endpoint tuple, answered by a disclosed protocol authority. */
import { answerMcpAuthorization } from "./native-browser-mcp-auth.mjs";
import { answerMcpProtocol } from "./native-browser-mcp-rpc.mjs";
import { nativeBrowserPlans } from "./native-browser-provider-fixtures.mjs";
import { publicAuthorityReply } from "./native-public-consent-authority.mjs";

export async function routeNativeMcpAuthority(context, harness, callback) {
  const plan = nativeBrowserPlans().find((item) => item.id === "adobe");
  const metadata = plan.methods.find((method) => method.kind === "mcp").mcp;
  const state = {
    calls: [],
    consent: null,
    rejectTools: false,
    registration: null,
    expectedResponses: new Map(),
    expectedDocuments: new Set(),
  };
  const clientId = "protocol-public-adobe-client";
  const access = "protocol-only-adobe-access";
  const refresh = "protocol-only-adobe-refresh";
  const management = "protocol-only-registration-management";
  const registrationUrl = `${metadata.registrationEndpoint}/${clientId}`;
  const admitted = new Set([
    metadata.url,
    metadata.resourceMetadata,
    metadata.discoveryUrl,
    metadata.authorizationEndpoint,
    metadata.registrationEndpoint,
    metadata.tokenEndpoint,
    metadata.revocationEndpoint,
    registrationUrl,
  ]);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!admitted.has(url.origin + url.pathname)) return route.fallback();
    const method = request.method();
    if (method === "OPTIONS") return publicAuthorityReply(route, null, 204);
    const headers = await request.allHeaders();
    harness.check(!headers.cookie, "MCP provider HTTP has no ambient cookies");
    state.calls.push({ url: url.origin + url.pathname, method });
    if (
      [metadata.registrationEndpoint, metadata.tokenEndpoint].includes(
        url.origin + url.pathname,
      )
    )
      harness.check(
        method === "POST" && !headers.authorization,
        "MCP credential mutations use public-client POST without an authorization secret",
      );
    if (url.origin + url.pathname === metadata.resourceMetadata)
      return publicAuthorityReply(route, {
        resource: metadata.resource,
        authorization_servers: [metadata.issuer],
      });
    if (url.origin + url.pathname === metadata.discoveryUrl)
      return publicAuthorityReply(route, {
        issuer: metadata.issuer,
        authorization_endpoint: metadata.authorizationEndpoint,
        token_endpoint: metadata.tokenEndpoint,
        registration_endpoint: metadata.registrationEndpoint,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    const authorization = answerMcpAuthorization(route, {
      request,
      url,
      metadata,
      state,
      callback,
      harness,
      clientId,
      access,
      refresh,
      management,
      registrationUrl,
    });
    if (authorization) return authorization;
    if (url.origin + url.pathname === metadata.revocationEndpoint) {
      const form = new URLSearchParams(request.postData());
      harness.check(
        [access, refresh].includes(form.get("token")),
        "cleanup revokes the actually issued token",
      );
      return publicAuthorityReply(route, null);
    }
    if (url.origin + url.pathname === registrationUrl) {
      harness.check(
        method === "DELETE" && headers.authorization === `Bearer ${management}`,
        "cleanup deletes the actual DCR registration with its private receipt",
      );
      return publicAuthorityReply(route, null, 204);
    }
    return answerMcpProtocol(route, {
      request,
      method,
      headers,
      state,
      access,
      harness,
    });
  });
  return { state, metadata, secrets: [access, refresh, management] };
}
