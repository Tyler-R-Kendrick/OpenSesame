import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import { isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { InteractionCsrf } from "../interactions/csrf.js";
import {
  buildLoginPageModel,
  finishLoginInteraction,
} from "../interactions/handlers.js";
import {
  SamlAuthError,
  admitSamlSubject,
  beginSamlAuth,
  samlOrgConfig,
  takeSamlCompletion,
} from "../interactions/saml.js";
import type {
  InteractionDetails,
  ProviderInteractions,
} from "../interactions/types.js";
import type { Variables } from "../middleware/context.js";
import { renderLoginPage } from "../ui/interaction-pages.js";

type NodeEnv = { Bindings: HttpBindings };

/** Same shape the slug column accepts, so a lookup cannot smuggle a path. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 64;

const UNAVAILABLE_MESSAGE =
  "That organization's SAML sign-in is not available right now.";

function providerInteractions(
  provider: OpenSesameProviderBundle["provider"],
): ProviderInteractions {
  // SAFETY: panva's Provider implements interactionDetails/interactionResult;
  // the Client generic is unused at this boundary.
  return overlapCast(provider);
}

/**
 * The native-SAML half of the interaction slot (C9 pattern, C14).
 *
 * Two routes, and the gap between them is the point:
 *
 * - `POST /:uid/federated/saml` starts the leg. The AuthnRequest goes out over
 *   HTTP-Redirect and the state that remembers why stays on the server.
 * - `GET /:uid/federated/saml/complete` finishes it. The ACS cannot: it is a
 *   cross-site POST carrying no `SameSite=Lax` cookie, so it cannot see the
 *   interaction at all (T25). It 303s here with a one-time code, and this
 *   top-level GET — same-site, cookie-bearing — resumes the interaction.
 */
export function createSamlInteractionRoutes(
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

  routes.post("/:uid/federated/saml", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const uid = c.req.param("uid");
    const fields = overlapCast(await c.req.parseBody());
    if (!csrf.verify(uid, isString(fields._csrf) ? fields._csrf : undefined)) {
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

    const slug = (isString(fields.slug) ? fields.slug : "")
      .trim()
      .toLowerCase();
    const organization =
      slug.length > 0 &&
      slug.length <= SLUG_MAX_LENGTH &&
      SLUG_PATTERN.test(slug)
        ? await ctx.stores.organizations.getBySlug(slug)
        : undefined;
    const cfg =
      organization && organization.state === "active"
        ? samlOrgConfig(organization)
        : undefined;

    if (cfg) {
      try {
        const { redirectUrl } = await beginSamlAuth(ctx, uid, cfg);
        return c.redirect(redirectUrl, 303);
      } catch (error) {
        if (!(error instanceof SamlAuthError)) throw error;
        ctx.log.warn(
          { code: error.code, organizationId: cfg.organizationId },
          "saml authn request could not be built",
        );
      }
    }

    // One answer for "no such organization", "not a SAML tenant" and "its IdP
    // metadata is unreachable": the login page is unauthenticated, and the
    // difference between those three is an enumeration oracle. The re-render
    // carries a fresh CSRF token — `csrf.verify` above consumed the last one
    // (T13).
    return c.html(
      renderLoginPage(
        await buildLoginPageModel(
          ctx,
          details,
          csrf.issue(details.uid),
          c.get("principalId"),
          { orgError: UNAVAILABLE_MESSAGE },
        ),
      ),
    );
  });

  routes.get("/:uid/federated/saml/complete", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const uid = c.req.param("uid");
    const loaded = await loadDetails(c, provider);
    if ("error" in loaded) {
      return c.text(loaded.error, loaded.status);
    }
    const { http, details } = loaded;
    if (details.prompt.name !== "login") {
      return c.text("Prompt mismatch", 400);
    }

    const completion = takeSamlCompletion(
      c.req.query("otc"),
      ctx.clock().getTime(),
    );
    // The code names the interaction the AuthnRequest was made from, and that
    // has to be the interaction this GET is resuming: a code spent against a
    // different one would sign this browser in on somebody else's ceremony.
    if (!completion || completion.interactionUid !== uid) {
      return c.text(
        "Sign-in state did not match. Start the sign-in again.",
        400,
      );
    }

    const admitted = await admitSamlSubject(ctx, {
      result: completion.result,
      correlationId: c.get("correlationId"),
      userAgent: c.req.header("user-agent") ?? "",
    });
    if (!admitted.ok) {
      if (admitted.status === 429) {
        return c.json({ error: admitted.message }, 429);
      }
      return c.text(admitted.message, admitted.status);
    }
    if (admitted.sessionToken !== undefined) {
      setCookie(c, ctx.config.provisionalCookieName, admitted.sessionToken, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
        secure: ctx.config.publicUrl.startsWith("https://"),
      });
    }

    const returnTo = await finishLoginInteraction(
      provider,
      http.req,
      http.res,
      admitted.principalId,
    );
    return c.redirect(returnTo, 303);
  });

  return routes;
}
