/**
 * OAuth-callback relay for Vercel Connect authorizations.
 *
 * Vercel Connect brokers the provider OAuth and holds every token. When an
 * authorization is started with a `callbackUrl` pointing here, Connect (or
 * the provider) returns the browser to this endpoint; this relay forwards
 * the browser to the app's `return_to` with every query param passed
 * through untouched. It holds no tokens, no secrets, and no sessions —
 * `return_to` is allowlisted to loopback http(s) and configured https
 * origins, so the relay can never bounce a browser anywhere else.
 *
 * Runs two ways with zero dependencies:
 * - locally: `node server.mjs` (or behind the dev HTTPS proxy),
 * - on Vercel: `api/connect/callback.mjs` is the same handler in a
 *   serverless function shape.
 */

import { returnToAllowed } from "./allowlist.mjs";

function passthroughParams(searchParams, skip) {
  const out = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (skip.has(key)) continue;
    out.append(key, value);
  }
  return out;
}

export function handleCallback(requestUrl, requestHost) {
  const incoming = new URL(requestUrl, "http://relay.invalid");
  const params = incoming.searchParams;
  const rawReturnTo = params.get("return_to") ?? "";
  const allowed = returnToAllowed(rawReturnTo, requestHost);
  if (!allowed) {
    return {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "Unknown return address.",
    };
  }
  const forward = passthroughParams(params, new Set(["return_to"]));
  const separator = allowed.search ? "&" : "?";
  const location = `${allowed.toString()}${forward.toString() ? `${separator}${forward.toString()}` : ""}`;
  return {
    status: 302,
    headers: { location },
    body: "",
  };
}
