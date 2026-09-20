import { connectCallbackBase } from "./connect-callback.js";

/**
 * Relay for App convert / install listing.
 * On loopback Vite, prefer the same origin (github-app-relay plugin) so listing
 * does not depend on a stale Connect process. Elsewhere use Connect base.
 */
export function githubAppRelayBase(
  origin = globalThis.location?.origin ?? "",
): string {
  const local = origin.replace(/\/+$/u, "");
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(local)) {
    return local;
  }
  const configured = connectCallbackBase().replace(/\/+$/u, "");
  if (configured !== "") return configured;
  return local;
}

/** GitHub-facing callback that bounces to `returnTo` with code + state. */
export function githubAppRedirectUrl(
  returnTo: string,
  origin = globalThis.location?.origin ?? "",
): string {
  const base = githubAppRelayBase(origin);
  return `${base}/api/github-app/callback?return_to=${encodeURIComponent(returnTo)}`;
}
