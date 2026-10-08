import { env } from "../host.js";
import { pageOrigin } from "../ports.js";

/** The client id this origin has at any origin-profile broker. */
export function originClientId(origin: string = pageOrigin()): string {
  return `origin:${origin}`;
}

/**
 * Where the upstream sends the browser back. The app root rather than a deep
 * path: a static host has no router, and the origin is all the broker derives
 * the client id from, so the path buys nothing and costs a 404.
 */
export function redirectUri(): string {
  const base = env().BASE_URL || "/";
  return `${pageOrigin()}${base}`;
}

/**
 * The ONE redirect URI the Identity API's auto-admitted origin client has:
 * `<origin>/opensesame/callback` (ADR 0050's canonical callback path). Every
 * brokered leg must use it — the base-path URI above is unregistered there
 * and dies at the authorize endpoint as an invalid redirect_uri, which is
 * exactly how every brokered button used to dead-end. GitHub Pages serves
 * this path through the 404 SPA fallback (the project prefix is matched
 * case-insensitively), and the dev server redirects it onto the base; either
 * way the app boots, sees `?code`, and finishes on the federation return
 * screen, which never cared what path it renders at.
 */
export function originCallbackUri(): string {
  return `${pageOrigin()}/opensesame/callback`;
}
