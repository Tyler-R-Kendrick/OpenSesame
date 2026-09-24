import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import {
  type OrgLdapConfig,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { AppContext } from "../context.js";
import type { InteractionCsrf } from "../interactions/csrf.js";
import {
  ProvisionalMintRefusedError,
  buildLoginPageModel,
  finishLoginInteraction,
  mintProvisionalForInteraction,
} from "../interactions/handlers.js";
import {
  type LdapBoundIdentity,
  LdapConfigurationError,
  ldapBind,
  ldapIssuer,
  roleForGroups,
} from "../interactions/ldap.js";
import type {
  InteractionDetails,
  ProviderInteractions,
} from "../interactions/types.js";
import type { Variables } from "../middleware/context.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import { organizationAssertedEmailIsVerified } from "../services/org-email-trust.js";
import {
  renderLoginPage,
  renderResumeHopPage,
} from "../ui/interaction-pages.js";
import { jitJoinOrganization } from "./organizations.js";
import { ensurePersonalOnAuthenticatedSession } from "./projects.js";
import { provisionedRoleForSubject } from "./scim.js";

type NodeEnv = { Bindings: HttpBindings };

/**
 * Directory sign-in, as a first-party credential POST (C21 / D17).
 *
 * INTEGRATOR: this is the C9 sub-router for LDAP. Mount it inside
 * `createInteractionRoutes` (`src/routes/interactions.ts`, S2's file) next to
 * the byo/org/realm/saml-complete lines, after the security-headers
 * middleware:
 *
 *   routes.route("/", createLdapInteractionRoutes(csrf));
 *
 * S1's `buildLoginPageModel` does not yet render an LDAP block, so the form
 * that posts here still has to be added to the login page: fields `slug`,
 * `username`, `password` and the hidden `_csrf`, posting to
 * `/interaction/<uid>/federated/ldap`. Until then the route is reachable and
 * complete, and the failure re-render borrows the org block's error slot.
 *
 * Unlike every redirect leg on this prefix, this one carries a password the
 * visitor typed into OUR page. That makes it the one federated entry point
 * that is genuinely CSRF-able and genuinely brute-forceable, so it is the one
 * that is CSRF-protected AND rate-limited.
 */

/** One answer for every failure, so the form is not a directory oracle (T34). */
const INVALID_CREDENTIALS_MESSAGE =
  "That username and password were not accepted.";

/** Same shape the slug column accepts, so a lookup cannot smuggle a path. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 64;

/** A password field is a credential, not a document. */
const MAX_CREDENTIAL_LENGTH = 512;

const ATTEMPT_WINDOW_MS = 600_000;
const ATTEMPT_PER_CLIENT = 10;
const ATTEMPT_GLOBAL = 200;
const ATTEMPT_KEYS = 2048;

/**
 * Module-local, like the BYO discovery budget (D5): the login page is
 * unauthenticated, so the fence has to exist before any principal does. Keyed
 * by a coarse client fingerprint plus a global ceiling, because an attacker
 * spreading guesses across fingerprints is the expected shape of this attack.
 */
const attempts = new Map<string, number[]>();

/** Test hook — the budget is process-global and must not leak between suites. */
export function resetLdapAttemptBudget(): void {
  attempts.clear();
}

function consumeAttemptBudget(fingerprint: string, now: number): boolean {
  for (const [key, values] of attempts) {
    const live = values.filter((at) => now - at < ATTEMPT_WINDOW_MS);
    if (live.length === 0) attempts.delete(key);
    else if (live.length !== values.length) attempts.set(key, live);
  }
  const global = attempts.get("__global__") ?? [];
  const client = attempts.get(fingerprint) ?? [];
  if (global.length >= ATTEMPT_GLOBAL || client.length >= ATTEMPT_PER_CLIENT) {
    return false;
  }
  global.push(now);
  client.push(now);
  attempts.set("__global__", global);
  attempts.set(fingerprint, client);
  while (attempts.size > ATTEMPT_KEYS) {
    const victim = [...attempts.keys()].find((key) => key !== "__global__");
    if (victim === undefined) break;
    attempts.delete(victim);
  }
  return true;
}

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

function clientFingerprint(
  userAgent: string | undefined,
  origin: string | undefined,
): string {
  return createHash("sha256")
    .update(userAgent ?? "")
    .update("|")
    .update(origin ?? "")
    .digest("hex")
    .slice(0, 16);
}

export function createLdapInteractionRoutes(
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

  routes.post("/:uid/federated/ldap", async (c) => {
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
    const { http, details } = loaded;
    if (details.prompt.name !== "login") {
      return c.text("Prompt mismatch", 400);
    }

    const slug = (isString(fields.slug) ? fields.slug : "")
      .trim()
      .toLowerCase();
    const username = isString(fields.username) ? fields.username : "";
    const password = isString(fields.password) ? fields.password : "";
    const correlationId = c.get("correlationId");
    const fingerprint = clientFingerprint(
      c.req.header("user-agent"),
      c.req.header("origin") ?? ctx.config.publicUrl,
    );

    /** Re-render with a spendable token (T13) and the one uniform message. */
    const refuse = async (status: 401 | 429) =>
      c.html(
        renderLoginPage(
          await buildLoginPageModel(
            ctx,
            details,
            csrf.issue(details.uid),
            c.get("principalId"),
            {
              orgSlug: slug,
              orgError:
                status === 429
                  ? "Too many sign-in attempts. Wait a few minutes and try again."
                  : INVALID_CREDENTIALS_MESSAGE,
            },
          ),
        ),
        status,
      );

    if (!consumeAttemptBudget(fingerprint, ctx.clock().getTime())) {
      return refuse(429);
    }

    if (
      !slug ||
      slug.length > SLUG_MAX_LENGTH ||
      !SLUG_PATTERN.test(slug) ||
      username.length > MAX_CREDENTIAL_LENGTH ||
      password.length > MAX_CREDENTIAL_LENGTH
    ) {
      return refuse(401);
    }

    const organization = await ctx.stores.organizations.getBySlug(slug);
    if (!organization || organization.state !== "active") return refuse(401);
    const config: OrgLdapConfig | null =
      await ctx.stores.orgFederation.ldapConfigs.get(organization.id);
    // A tenant with no directory answers exactly like a wrong password: the
    // form is unauthenticated, and "this org uses LDAP" is itself a fact worth
    // not leaking.
    if (!config) return refuse(401);

    let bound: LdapBoundIdentity | { ok: false };
    try {
      bound = await ldapBind(ctx, config, username, password);
    } catch (error) {
      if (error instanceof LdapConfigurationError) {
        // The operator's mistake, not the visitor's — and not something to
        // describe on an unauthenticated page.
        ctx.log.error(
          {
            organizationId: organization.id,
            code: error.code,
          },
          "LDAP configuration refused",
        );
        return c.text("Directory sign-in is unavailable.", 503);
      }
      throw error;
    }
    if (!bound.ok) return refuse(401);

    const issuer = ldapIssuer(config);
    const existing = await ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer,
      subject: bound.subject,
    });

    let accountId: string;
    if (existing) {
      const principal = await ctx.repos.principals.getById(
        existing.principalId,
      );
      if (principal && principal.state !== "active") {
        return c.text("This account is not able to sign in.", 403);
      }
      accountId = existing.principalId;
    } else {
      let minted: { principalId: string; accessToken: string };
      try {
        minted = await mintProvisionalForInteraction(
          ctx,
          fingerprint,
          correlationId,
        );
      } catch (error) {
        if (error instanceof ProvisionalMintRefusedError) {
          return c.json({ error: error.code }, 429);
        }
        throw error;
      }

      const emailVerified =
        bound.email !== undefined &&
        (await organizationAssertedEmailIsVerified(
          ctx,
          organization.id,
          bound.email,
        ));
      const attached = await attachVerifiedExternalIdentity(
        ctx,
        minted.principalId,
        {
          kind: "ldap",
          issuer,
          subject: bound.subject,
          correlationId,
          ...(bound.name !== undefined
            ? { displayHint: bound.name }
            : undefined),
          ...(bound.email !== undefined
            ? { emailNormalized: bound.email, emailVerified }
            : undefined),
        },
      );
      if (!attached.ok) {
        return c.text(attached.message, 409);
      }
      // Follow the identity row, never the mint: the verified-email policy may
      // have attached this directory identity to a principal that already
      // existed (D15), and that principal is the account signing in.
      accountId = attached.identity.principalId;
      await ensurePersonalOnAuthenticatedSession(ctx, accountId, correlationId);
      if (accountId === minted.principalId) {
        setCookie(c, ctx.config.provisionalCookieName, minted.accessToken, {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
          secure: ctx.config.publicUrl.startsWith("https://"),
        });
      }
    }

    // Membership follows the bind: the tenant's own directory just vouched for
    // this human, and the groups it listed decide the role. Where the bind
    // named no group this tenant maps, a SCIM push may still have said what
    // this subject joins as (C15) — the LDAP mapping wins because it comes
    // from the directory that just authenticated them.
    const role =
      roleForGroups(config, bound.groups) ??
      (await provisionedRoleForSubject(ctx, organization.id, bound.subject));
    const joined = await jitJoinOrganization(ctx, {
      organization,
      principalId: accountId,
      subject: bound.subject,
      method: "ldap",
      correlationId,
      ...(role !== undefined ? { role } : undefined),
    });
    if (!joined.ok) {
      return c.text(joined.message, 403);
    }

    const returnTo = await finishLoginInteraction(
      provider,
      http.req,
      http.res,
      accountId,
    );
    // Not a 303: the resume can end at the relying party's origin, and
    // Chromium refuses cross-origin redirects of a form submission under
    // `form-action 'self'` (see renderHopPage).
    return c.html(renderResumeHopPage(returnTo));
  });

  return routes;
}
