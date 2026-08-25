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
import { normalizeEmailDomain } from "./org-domains.js";
import { renderLoginPage } from "../ui/interaction-pages.js";

type NodeEnv = { Bindings: HttpBindings };

/** Longer than any deliverable address (RFC 5321 caps the path at 256). */
const MAX_EMAIL_LENGTH = 320;

/**
 * One answer for every address that routes nowhere.
 *
 * Unknown domain, claimed-but-unverified domain, and "not an address at all"
 * are deliberately indistinguishable: the login page is unauthenticated, and a
 * page that answered differently would tell a stranger which companies use
 * this deployment and which of them are mid-onboarding.
 */
const NO_REALM_MESSAGE = "No organization uses that email domain.";

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
 * The domain half of a submitted work email, or `undefined`.
 *
 * The local part is never bound to a name, never logged, and never returned:
 * it is the one piece of this input that identifies a human, and home-realm
 * discovery has no use for it (D12/T28). What survives this function is a
 * domain — a public fact about a company — and nothing else.
 */
function domainOf(submitted: string): string | undefined {
  if (submitted.length > MAX_EMAIL_LENGTH) return undefined;
  const at = submitted.lastIndexOf("@");
  if (at <= 0 || at === submitted.length - 1) return undefined;
  return normalizeEmailDomain(submitted.slice(at + 1));
}

/**
 * Home-realm discovery on the hosted login page (C16, D12).
 *
 * "Continue with your work email" is a router, not a sign-in: it takes an
 * address, keeps the domain, and 303s to the organization's own method list at
 * `GET /interaction/:uid?org=<slug>`. The address itself reaches no log, no
 * audit row and no store — the second the domain is extracted the rest is
 * gone. That separation is the whole reason this field can exist next to the
 * email magic-link field without becoming a second, silent, identity-collecting
 * surface (D18 collects an address deliberately; this one must not).
 *
 * Only VERIFIED domains route. A claim that has not passed its DNS check is
 * an assertion by whoever typed it into the org settings page, and honouring
 * it would let anyone redirect a competitor's employees to their own IdP.
 */
export function createRealmInteractionRoutes(
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

  routes.post("/:uid/federated/realm", async (c) => {
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

    const domain = domainOf(
      (isString(fields.email) ? fields.email : "").trim().toLowerCase(),
    );
    const claim = domain
      ? await ctx.stores.orgFederation.emailDomains.findVerified(domain)
      : null;
    const organization = claim
      ? await ctx.stores.organizations.get(claim.organizationId)
      : undefined;
    if (
      !organization ||
      organization.state === "deleted" ||
      organization.state === "suspended"
    ) {
      // Re-render in place with a token the next submit can actually spend:
      // `csrf.verify` above consumed the one this form carried (T13). The
      // model is rebuilt without the submitted value — re-populating the field
      // would put the address back on the wire.
      return c.html(
        renderLoginPage(
          await buildLoginPageModel(
            ctx,
            details,
            csrf.issue(details.uid),
            c.get("principalId"),
            { realmError: NO_REALM_MESSAGE },
          ),
        ),
      );
    }

    return c.redirect(
      `${interactionPath(uid)}?org=${encodeURIComponent(organization.slug)}`,
      303,
    );
  });

  return routes;
}
