import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import { isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import type { InteractionCsrf } from "../interactions/csrf.js";
import { buildLoginPageModel } from "../interactions/handlers.js";
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

const UNKNOWN_ORGANIZATION_MESSAGE =
  "No organization sign-in is configured for that name.";

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
 * Organization sign-in, step one (D6).
 *
 * The hosted pages run under `default-src 'none'` with no `script-src`, so the
 * tenant lookup cannot be a fetch: it is a plain form POST that 303s to
 * `GET /interaction/:uid?org=<slug>`, and that render carries the tenant's
 * method buttons. The redirect is also what keeps the single-use CSRF token
 * honest — the follow-up GET issues a fresh one (T13), which is why the only
 * branch that renders in place issues one explicitly.
 *
 * A slug that names nothing gets exactly the same answer as one that names a
 * tenant with no configured method: the login page is unauthenticated, and
 * telling a stranger which organizations exist is an enumeration oracle.
 */
export function createOrgInteractionRoutes(
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

  routes.post("/:uid/federated/org", async (c) => {
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
    if (
      !slug ||
      slug.length > SLUG_MAX_LENGTH ||
      !SLUG_PATTERN.test(slug) ||
      !(await ctx.stores.organizations.getBySlug(slug))
    ) {
      // Re-render in place, with a token the next submit can actually spend:
      // `csrf.verify` above consumed the one this form carried.
      return c.html(
        renderLoginPage(
          await buildLoginPageModel(
            ctx,
            details,
            csrf.issue(details.uid),
            c.get("principalId"),
            { orgError: UNKNOWN_ORGANIZATION_MESSAGE },
          ),
        ),
      );
    }

    return c.redirect(
      `${interactionPath(uid)}?org=${encodeURIComponent(slug)}`,
      303,
    );
  });

  return routes;
}
