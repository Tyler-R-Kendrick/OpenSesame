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

/**
 * A dedicated worker inherits its owner document's cross-origin isolation.
 * Navigations above are served `Cross-Origin-Embedder-Policy: require-corp`,
 * and Chromium then refuses a worker script that does not carry the same
 * header — reporting it as an `error` event with no message, no filename and
 * nothing in the console, which is why it is easy to miss. A worker built
 * from a `blob:` URL inherits the document's policy and works, so only the
 * same-origin script path is affected.
 */
export function isolatedWorkerScript(response: Response): Response {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
