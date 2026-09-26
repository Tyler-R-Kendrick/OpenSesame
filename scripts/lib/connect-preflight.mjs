/**
 * Live preflight of every connector's real endpoints (ADR 0146). Read-only:
 * an authorization request with a placeholder client (a live endpoint answers
 * with a login page, a redirect or `invalid_client` — never 404), the
 * provider's discovery document compared with the preset, each MCP server's
 * RFC 9728 → RFC 8414 chain, and each API key's verify call made with no key
 * (a live endpoint demands one). Nothing is registered and no token is
 * requested.
 */
import {
  discoverAuthorizationServer,
  discoverProtectedResource,
} from "./oauth-discovery.mjs";

/** An endpoint that answered like a live OAuth / API surface. */
export function liveStatus(status) {
  return status >= 200 && status < 500 && status !== 404 && status !== 410;
}

const TEMPLATE = /\{[a-z_]+\}/;

async function probe(fetchImpl, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    // The caller's init first: its headers are merged under ours, and it can
    // never follow a redirect or outlive the timeout.
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        "user-agent": "opensesame-connect-preflight/1",
        ...init.headers,
      },
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel?.();
    return response.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

export async function preflightOauth(row, { fetchImpl = fetch, fetchJson }) {
  if (TEMPLATE.test(row.authorization_endpoint)) {
    return {
      service: row.service,
      kind: "oauth",
      result: "needs_account_host",
    };
  }
  const url = new URL(row.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "opensesame-preflight");
  url.searchParams.set(
    "redirect_uri",
    "https://api.vercel.com/v1/connect/callback",
  );
  url.searchParams.set("state", "preflight");
  const status = await probe(fetchImpl, url.toString());
  const out = {
    service: row.service,
    kind: "oauth",
    authorize_status: status,
    result: liveStatus(status) ? "live" : "unreachable",
  };
  if (status === 404) {
    // Some servers (Twilio) answer an unregistered client with 404; a token
    // endpoint that answers a GET (405, 400) shows the server is there.
    const token = await probe(fetchImpl, row.token_endpoint);
    out.token_status = token;
    if (liveStatus(token)) out.result = "live_unknown_client_404";
  }
  if (row.discovery_url && fetchJson) {
    const issuer = row.discovery_url.split("/.well-known/")[0];
    const found = await discoverAuthorizationServer(fetchJson, issuer);
    out.discovery = found
      ? {
          authorization_endpoint_matches:
            found.authorization_endpoint === row.authorization_endpoint,
          token_endpoint_matches: found.token_endpoint === row.token_endpoint,
        }
      : "unavailable";
  }
  return out;
}

export async function preflightMcp(service, url, { fetchJson }) {
  const found = await discoverProtectedResource(fetchJson, url);
  return {
    service,
    kind: "mcp",
    url,
    result: found.status === "ok" ? "live" : "no_oauth_metadata",
    registration: found.client_registration ?? null,
  };
}

export async function preflightApiKey(row, { fetchImpl = fetch }) {
  const verify = row.verify;
  if (!verify || TEMPLATE.test(verify.url.replace("{key}", "x"))) {
    return {
      service: row.service,
      kind: "api-key",
      result: "needs_account_host",
    };
  }
  // A well-formed placeholder: some APIs 404 a malformed key in the path.
  const placeholder = "123456789:AAInvalidInvalidInvalidInvalidInvalid00";
  const status = await probe(
    fetchImpl,
    verify.url.replace("{key}", placeholder),
    {
      method: verify.method,
      headers: verify.body ? { "content-type": "application/json" } : {},
      body: verify.body ?? undefined,
    },
  );
  return {
    service: row.service,
    kind: "api-key",
    verify_status: status,
    // No key: a live API refuses (401/403), or answers an error body (GraphQL).
    result:
      status === 401 || status === 403 || status === 400 || status === 200
        ? "live"
        : liveStatus(status)
          ? "answered"
          : "unreachable",
  };
}

export async function pool(items, size, run) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index]);
      }
    }),
  );
  return out;
}
