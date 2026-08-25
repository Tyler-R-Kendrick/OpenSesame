import type { HttpBindings } from "@hono/node-server";
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { STATE_UID_SEPARATOR } from "../interactions/federated.js";
import type { Variables } from "../middleware/context.js";

type NodeEnv = { Bindings: HttpBindings };

/**
 * The stable, deployment-wide federated callback (ADR 0055), mounted at
 * `/v1/federated/callback`.
 *
 * A redirect URI is registered once — by an operator in Google's or Entra's
 * console, or by RFC 7591 on a visitor's first bring-your-own sign-in — and
 * those providers then match it byte for byte. `/interaction/<uid>/federated/
 * callback` names an interaction that exists for one sign-in, so a client
 * registered against it is a client that can complete at most one, and for a
 * console that demands the URI up front, none. Every registered upstream
 * therefore comes back here (see `usesStableCallback`).
 *
 * `federated-signin.md` §7.1 says the callback belongs under `/interaction/:uid`
 * because oidc-provider's interaction cookie is path-scoped there. That is
 * right about RESUMING the interaction and not about RECEIVING the response:
 * receiving needs no cookie, and this route reads none. Resuming still happens
 * under that path, which is exactly what the 303 below is for — a top-level GET
 * does carry the `SameSite=Lax` interaction cookie that a cross-site redirect
 * or POST from an IdP does not.
 *
 * This route completes nothing. It copies the authorization response — five
 * short, allowlisted parameters — onto the interaction's own callback and
 * stops, which is the same re-materialization the Apple `form_post` handler
 * does (D3/T4) and the same hand-back the SAML ACS does (C14/T25). SAML needs a
 * server-side completion code because a signed assertion is far too large to
 * put back into a query string; an authorization response is not, so there is
 * no server-side state here to expire, to replicate between nodes, or to leak.
 *
 * Which interaction to hand back to comes from `state`, which the leg prefixes
 * with the uid (`interactionScopedState`). A `state` that names no interaction,
 * or names something that is not an interaction id, is refused here rather than
 * falling through to a default — and one that names an interaction whose
 * pending cookie the sender does not hold dies at the exchange, where `state`
 * is still compared byte for byte.
 */

/**
 * The only parameters copied onward: an allowlist, not a filter. Everything
 * else an upstream sends — Apple's `user`, an `id_token`, whatever a future
 * revision adds — is dropped rather than reflected into a URL this server then
 * redirects a browser to.
 *
 * `iss` rides along because RFC 9207 requires a client to check it when the
 * authorization server advertises support, and openid-client does.
 */
const CALLBACK_PARAMS = [
  "code",
  "state",
  "error",
  "error_description",
  "iss",
] as const;

/**
 * Length cap for a re-materialized parameter. Authorization codes are a few
 * hundred bytes; anything near this is not one, and a redirect URL assembled
 * from unbounded input is a denial-of-service in a header.
 */
const MAX_CALLBACK_PARAM_LENGTH = 2048;

/** oidc-provider mints interaction uids as base64url; nothing else is one. */
const UID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The interaction a `state` names, or `undefined` when it names none.
 *
 * Validated rather than trusted: the value is echoed back by an upstream and
 * lands in a path this server then redirects a browser to, so anything that is
 * not the uid shape oidc-provider mints is refused before it can become one.
 */
function interactionUidFromState(
  state: string | undefined,
): string | undefined {
  if (state === undefined) return undefined;
  const separator = state.indexOf(STATE_UID_SEPARATOR);
  if (separator <= 0) return undefined;
  const uid = state.slice(0, separator);
  return UID_PATTERN.test(uid) ? uid : undefined;
}

/** Where to send the browser, or `undefined` when nothing names one. */
function handBack(
  read: (name: string) => string | undefined,
): string | undefined {
  const uid = interactionUidFromState(read("state"));
  if (uid === undefined) return undefined;
  const params = new URLSearchParams();
  for (const name of CALLBACK_PARAMS) {
    const value = read(name);
    if (value === undefined || value.length === 0) continue;
    if (value.length > MAX_CALLBACK_PARAM_LENGTH) continue;
    params.set(name, value);
  }
  const query = params.toString();
  return `/interaction/${encodeURIComponent(uid)}/federated/callback${
    query ? `?${query}` : ""
  }`;
}

/**
 * One answer for every response this route cannot place. It is unauthenticated
 * and anybody may reach it with anything; the browser that actually started a
 * sign-in is told to start again, and nobody is told anything else.
 */
const UNPLACEABLE = "Sign-in state did not match. Start the sign-in again.";

export function createFederatedCallbackRoutes(): Hono<
  { Variables: Variables } & NodeEnv
> {
  const routes = new Hono<{ Variables: Variables } & NodeEnv>();

  routes.get("/callback", (c) => {
    const target = handBack((name) => c.req.query(name));
    if (target === undefined) return c.text(UNPLACEABLE, 400);
    return c.redirect(target, 303);
  });

  /**
   * `response_mode=form_post` (D3/T4). Apple answers the authorization request
   * with a cross-site POST from `appleid.apple.com` to the registered redirect
   * URI — which is now this one — and that request carries no `SameSite=Lax`
   * cookie of ours at all. It needs none: like the GET above, this handler
   * reads no cookie and completes nothing. There is no CSRF token because
   * there is no authority here to abuse; the redirect target is this server's
   * own interaction callback, and `state` byte-equality against the pending
   * cookie is still what decides whether anything completes.
   */
  routes.post("/callback", async (c) => {
    const fields: JsonObject = overlapCast(await c.req.parseBody());
    const target = handBack((name) => {
      const value = fields[name];
      return isString(value) ? value : undefined;
    });
    if (target === undefined) return c.text(UNPLACEABLE, 400);
    return c.redirect(target, 303);
  });

  return routes;
}
