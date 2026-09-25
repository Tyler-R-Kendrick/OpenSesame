/**
 * OAuth discovery for a protected resource (an MCP server, an API) — RFC 9728
 * protected-resource metadata, then RFC 8414 / OIDC authorization-server
 * metadata. Pure over an injected `fetchJson`, so the pin script and the live
 * preflight share it and the unit test drives it without a network.
 *
 * Reads only: every request is a GET of a well-known document. Nothing here
 * registers a client or asks for a token.
 */

/** RFC 9728 §3.1 / RFC 8414 §3.1: insert the well-known segment before the path. */
export function wellKnownUrls(resourceUrl, suffix) {
  const url = new URL(resourceUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const out = [];
  if (path) out.push(`${url.origin}/.well-known/${suffix}${path}`);
  out.push(`${url.origin}/.well-known/${suffix}`);
  return out;
}

const PKCE_METHODS = new Set(["S256", "plain"]);

function strings(value, max = 24) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string").slice(0, max)
    : [];
}

function https(value) {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** The fields a connector page and a Connect create body need, nothing else. */
export function summarizeServerMetadata(meta) {
  const registration = https(meta.registration_endpoint);
  const cimd = meta.client_id_metadata_document_supported === true;
  return {
    issuer: https(meta.issuer),
    authorization_endpoint: https(meta.authorization_endpoint),
    token_endpoint: https(meta.token_endpoint),
    revocation_endpoint: https(meta.revocation_endpoint),
    registration_endpoint: registration,
    client_registration: cimd ? "cimd" : registration ? "dcr" : "manual",
    code_challenge_methods: strings(
      meta.code_challenge_methods_supported,
      4,
    ).filter((method) => PKCE_METHODS.has(method)),
    token_endpoint_auth_methods: strings(
      meta.token_endpoint_auth_methods_supported,
      6,
    ),
    scopes_supported: strings(meta.scopes_supported, 24),
  };
}

async function firstJson(fetchJson, urls) {
  for (const url of urls) {
    const reply = await fetchJson(url);
    if (reply.ok && reply.body && typeof reply.body === "object") {
      return { url, body: reply.body };
    }
  }
  return null;
}

/** Authorization-server metadata at an issuer (RFC 8414 first, then OIDC). */
export async function discoverAuthorizationServer(fetchJson, issuer) {
  const urls = [
    ...wellKnownUrls(issuer, "oauth-authorization-server"),
    ...wellKnownUrls(issuer, "openid-configuration"),
  ];
  const found = await firstJson(fetchJson, [...new Set(urls)]);
  if (!found || !https(found.body.authorization_endpoint)) return null;
  return { discovery_url: found.url, ...summarizeServerMetadata(found.body) };
}

/**
 * Protected resource → its authorization server. Falls back to metadata at
 * the resource's own origin (the MCP 2025-03 shape, where the MCP server is
 * its own authorization server).
 */
export async function discoverProtectedResource(fetchJson, resourceUrl) {
  const prm = await firstJson(
    fetchJson,
    wellKnownUrls(resourceUrl, "oauth-protected-resource"),
  );
  const servers = prm ? strings(prm.body.authorization_servers, 4) : [];
  const issuer =
    servers.map(https).find(Boolean) ?? new URL(resourceUrl).origin;
  const server = await discoverAuthorizationServer(fetchJson, issuer);
  if (!server) {
    return {
      status: "no_metadata",
      resource: resourceUrl,
      resource_metadata: prm?.url ?? null,
    };
  }
  return {
    status: "ok",
    resource: https(prm?.body.resource) ?? resourceUrl,
    resource_metadata: prm?.url ?? null,
    scopes_supported: prm
      ? strings(prm.body.scopes_supported, 24)
      : server.scopes_supported,
    ...server,
  };
}

/** A bounded JSON GET with a timeout; never throws. */
export function makeFetchJson({
  timeoutMs = 12_000,
  maxBytes = 256_000,
  fetchImpl = fetch,
} = {}) {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "follow",
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok || text.length > maxBytes) {
        return { ok: false, status: response.status };
      }
      try {
        return { ok: true, status: response.status, body: JSON.parse(text) };
      } catch {
        return { ok: false, status: response.status };
      }
    } catch {
      return { ok: false, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  };
}
