import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import { overlapCast, readString } from "@opensesame/os-domain";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { registerByoUpstream } from "../interactions/byo.js";
import type { InteractionCsrf } from "../interactions/csrf.js";
import {
  FederatedAuthError,
  beginFederatedAuth,
  encodePending,
  pendingCookieName,
  stableFederatedRedirectUri,
} from "../interactions/federated.js";
import { buildLoginPageModel } from "../interactions/handlers.js";
import type {
  InteractionDetails,
  ProviderInteractions,
} from "../interactions/types.js";
import type { Variables } from "../middleware/context.js";
import { renderLoginPage } from "../ui/interaction-pages.js";

type NodeEnv = { Bindings: HttpBindings };

/** The upstream round-trip is interactive; ten minutes is generous for it. */
const FEDERATED_PENDING_TTL_SECONDS = 600;

/** Echoed back into the form on a re-render; longer is not an issuer. */
const MAX_ECHOED_ISSUER_LENGTH = 512;

/**
 * What a visitor is told when the leg itself refuses after the record exists.
 *
 * `beginFederatedAuth` re-resolves the issuer through the trust fence and then
 * discovers it as the client the record names, so it can still fail here —
 * most plausibly because the issuer's own client registration does not match
 * what was typed. The page is the right place to say so, which is why this
 * answers with the form rather than the leg's bare 502.
 */
const START_FAILED_MESSAGE =
  "That provider could not start a sign-in for this server.";

function interactionPath(uid: string): string {
  return `/interaction/${encodeURIComponent(uid)}`;
}

function providerInteractions(
  provider: OpenSesameProviderBundle["provider"],
): ProviderInteractions {
  // SAFETY: panva's Provider implements interactionDetails/interactionResult;
  // the Client generic is unused at this boundary.
  return overlapCast(provider);
}

/**
 * Bring your own identity provider, step one (D5, C9).
 *
 * The visitor posts an issuer URL and, optionally, a client id and secret they
 * registered at that IdP. Everything hard happens in `interactions/byo.ts`
 * (SSRF-guarded discovery, RFC 7591 registration, the abuse budget, the
 * durable record); this route is the HTTP shape around it: verify the CSRF
 * token, register, then hand the browser to the upstream through exactly the
 * same `beginFederatedAuth` the catalog buttons use. The leg is admitted by
 * the trust fence's `"byo"` branch (C2), so nothing downstream needs to know
 * this sign-in started from a form instead of a button.
 *
 * Under `default-src 'none'` with no `script-src` (T5) this is a plain
 * POST → 303 → GET; there is no fetch to make and no JSON to render.
 */
export function createByoInteractionRoutes(
  csrf: InteractionCsrf,
): Hono<{ Variables: Variables } & NodeEnv> {
  const routes = new Hono<{ Variables: Variables } & NodeEnv>();

  // Deliberately local rather than shared with `interactions.ts`: C9 keeps the
  // sub-router files disjoint, and the helper is four lines.
  async function loadDetails(
    c: { env: HttpBindings },
    provider: ProviderInteractions,
  ): Promise<
    | {
        http: { req: IncomingMessage; res: ServerResponse };
        details: InteractionDetails;
      }
    | { error: string; status: 404 | 501 }
  > {
    const req = c.env?.incoming;
    const res = c.env?.outgoing;
    if (!req || !res) {
      return {
        error: "OIDC interactions require the Node HTTP adapter",
        status: 501,
      };
    }
    try {
      return {
        http: { req, res },
        details: await provider.interactionDetails(req, res),
      };
    } catch {
      return { error: "Interaction not found or expired", status: 404 };
    }
  }

  routes.post("/:uid/federated/byo", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const uid = c.req.param("uid");
    const fields = overlapCast(await c.req.parseBody());
    if (!csrf.verify(uid, readString(fields._csrf))) {
      return c.text("Invalid or expired CSRF token", 403);
    }
    const loaded = await loadDetails(c, provider);
    if ("error" in loaded) {
      return c.text(loaded.error, loaded.status);
    }
    const { details } = loaded;
    if (details.prompt.name !== "login") {
      return c.text("Prompt mismatch", 400);
    }

    const submittedIssuer = (readString(fields.issuer) ?? "").trim();
    const submittedClientId = readString(fields.client_id);
    const submittedClientSecret = readString(fields.client_secret);

    /**
     * Re-render the form in place, carrying the issuer back so the visitor can
     * correct one character rather than retype the URL.
     *
     * The token is FRESH by necessity, not by politeness: `csrf.verify` above
     * consumed the one this submission carried, so a re-render that echoed it
     * would 403 the very next attempt (T13).
     */
    async function rejected(message: string): Promise<Response> {
      return c.html(
        renderLoginPage(
          await buildLoginPageModel(
            ctx,
            details,
            csrf.issue(details.uid),
            c.get("principalId"),
            {
              byoError: message,
              byoIssuer: submittedIssuer.slice(0, MAX_ECHOED_ISSUER_LENGTH),
            },
          ),
        ),
        422,
      );
    }

    // The same user-agent-derived abuse key the interaction's other unauth-
    // enticated POSTs mint. It is a fence against one browser hammering the
    // endpoint, never an identifier: nothing durable is keyed by it.
    const fingerprint = createHash("sha256")
      .update(c.req.header("user-agent") ?? "")
      .update("|")
      .update(c.req.header("origin") ?? "")
      .digest("hex")
      .slice(0, 16);

    const outcome = await registerByoUpstream(
      ctx,
      {
        issuer: submittedIssuer,
        ...(submittedClientId !== undefined
          ? { clientId: submittedClientId }
          : undefined),
        ...(submittedClientSecret !== undefined
          ? { clientSecret: submittedClientSecret }
          : undefined),
        // The DCR path registers the deployment-wide callback, never this
        // interaction's: RFC 7591 registers a redirect_uri once and the IdP
        // then matches it exactly, so a per-interaction URI would sign this
        // visitor in today and refuse them tomorrow (ADR 0055).
        redirectUri: stableFederatedRedirectUri(ctx.config),
      },
      fingerprint,
    );
    if ("error" in outcome) {
      return rejected(outcome.message);
    }

    try {
      const { authorizationUrl, pending } = await beginFederatedAuth(
        ctx,
        uid,
        outcome.record.issuer,
      );
      setCookie(c, pendingCookieName(uid), encodePending(pending), {
        httpOnly: true,
        sameSite: "Lax",
        path: interactionPath(uid),
        maxAge: FEDERATED_PENDING_TTL_SECONDS,
        secure: ctx.config.publicUrl.startsWith("https://"),
      });
      return c.redirect(authorizationUrl, 303);
    } catch (error) {
      if (error instanceof FederatedAuthError) {
        return rejected(START_FAILED_MESSAGE);
      }
      throw error;
    }
  });

  return routes;
}
