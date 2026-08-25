import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import type { Variables } from "../middleware/context.js";
import {
  BetterAuthBridgeError,
  principalForBetterAuthSubject,
  upstreamAuthFor,
  verifyMagicLinkToken,
} from "../services/better-auth-bridge.js";

type NodeEnv = { Bindings: HttpBindings };

/**
 * The Better Auth mount (C20 / D16 / ADR 0057).
 *
 * Better Auth is here for one job — email magic-link — and this router is the
 * fence that keeps it to that job. Everything under `/v1/auth/*` is refused
 * unless it is on the allowlist below, which is a single endpoint.
 *
 * An allowlist rather than a deny list, for two reasons that are both security
 * properties rather than tidiness:
 *
 *  - Social sign-in must not be reachable (T22). Better Auth's social endpoints
 *    exist whether or not any provider is configured, and its
 *    `toBetterAuthSocialConfig` silently drops providers that have no client
 *    secret — which is every origin-profile broker OpenSesame fronts. A
 *    half-configured social leg that answers 400 today is one dependency bump
 *    away from answering 302, so it does not get to answer at all. The provider
 *    registry owns social.
 *  - Better Auth's own `/magic-link/verify` and `/get-session` answer with its
 *    user record, and its user id must never cross this API boundary (T33).
 *    The verification is performed server-side by the bridge instead, which
 *    reads that record, writes the `better_auth_subjects` mapping, and hands
 *    back a principal id and a first-party bearer.
 *
 * What is left is `POST /v1/auth/sign-in/magic-link`, whose entire response is
 * `{ status: true }` — no user, no id, no answer about whether the address is
 * known to this deployment.
 */

/** The only Better Auth path this deployment serves over HTTP. */
const ALLOWED_BETTER_AUTH_PATHS = new Set(["/sign-in/magic-link"]);

/** Long enough for any token Better Auth mints; short enough not to be a buffer. */
const MAX_TOKEN_LENGTH = 512;

/**
 * The two ways the provisional-mint fence refuses. Both are "come back later",
 * so both answer 429 — the same mapping the interaction login route uses, so a
 * client does not have to learn which surface it is talking to.
 */
const MINT_REFUSALS = new Set(["rate_limited", "provisional_capacity"]);

export function createUpstreamAuthRoutes(
  ctx: AppContext,
): Hono<{ Variables: Variables } & NodeEnv> {
  const routes = new Hono<{ Variables: Variables } & NodeEnv>();
  // The handlers use the `ctx` this router was built with rather than
  // `c.get("ctx")`: the middleware puts the same object on every request, and
  // reading it from the closure is what binds the Better Auth instance and the
  // mailer seam to one control plane.
  //
  // `upstreamAuthFor` is deliberately NOT called here. It is memoized per
  // context, so the mount and the interaction sub-router already share one
  // instance; building it at mount time would only mean every deployment that
  // never sends a magic link still pays for a Better Auth init, and fails at
  // boot on a configuration Better Auth dislikes but this API never consults.

  /**
   * The landing page for a link that was NOT started from a hosted interaction
   * (D18): a first-party client — Pages' first-run screen, the console — asked
   * for the link itself, so there is no interaction to resume and the answer is
   * the session, in the shape `POST /v1/principals/federated-session` returns
   * (C13). The client adopts it with `restoreSession` exactly the same way.
   *
   * Registered ahead of the Better Auth handler; Better Auth serves no path by
   * this name, so nothing is shadowed.
   */
  routes.get("/magic-link/complete", async (c) => {
    const token = c.req.query("token") ?? "";
    // One answer for a token that never existed, one that expired, and one that
    // was already spent: distinguishing them tells a holder of a random string
    // which part of it was nearly right.
    const invalid = () =>
      c.json({ error: "invalid_token" } as const, 401 as const);
    if (!token || token.length > MAX_TOKEN_LENGTH) return invalid();

    const subject = await verifyMagicLinkToken(ctx, token);
    if (!subject) return invalid();

    try {
      const adopted = await principalForBetterAuthSubject(
        ctx,
        subject,
        c.get("correlationId"),
      );
      return c.json(adopted, 200);
    } catch (error) {
      if (error instanceof BetterAuthBridgeError) {
        return c.json(
          { error: error.code, message: error.message },
          MINT_REFUSALS.has(error.code) ? 429 : 403,
        );
      }
      throw error;
    }
  });

  routes.all("/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname.slice("/v1/auth".length) || "/";
    if (!ALLOWED_BETTER_AUTH_PATHS.has(path)) {
      // 404, not 403: the endpoints this deployment does not serve should not
      // be distinguishable from endpoints that do not exist.
      return c.json({ error: "not_found" }, 404);
    }
    return upstreamAuthFor(ctx).auth.handler(c.req.raw);
  });

  return routes;
}
