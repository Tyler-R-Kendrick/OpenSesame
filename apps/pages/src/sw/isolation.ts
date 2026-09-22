/**
 * Response headers a static host cannot send. The worker adds them on the
 * way through so documents run cross-origin isolated, except the broker and
 * local-IAM popups, which must keep `window.opener` (ADR 0034).
 */

import { crossOriginOpenerPolicy } from "../lib/opener-policy.js";

export function isolated(
  response: Response,
  requestUrl: URL,
  scopePath: string,
): Response {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  if (requestUrl.pathname.includes("/broker/")) {
    // Broker popups must keep window.opener so postMessage can reach the RP.
    // COOP same-origin would null opener and break delivery.
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
  } else {
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    const coop = crossOriginOpenerPolicy(requestUrl.pathname, scopePath);
    if (coop) headers.set("Cross-Origin-Opener-Policy", coop);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
