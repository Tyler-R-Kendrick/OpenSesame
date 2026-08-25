import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../context.js";
import { createInteractionCsrf } from "../interactions/csrf.js";
import {
  FederatedAuthError,
  type FederatedIdentity,
  type PendingFederatedAuth,
  beginFederatedAuth,
  completeFederatedAuth,
  decodePending,
  encodePending,
  pendingCookieName,
} from "../interactions/federated.js";
import {
  ProvisionalMintRefusedError,
  buildConsentPageModel,
  buildLoginPageModel,
  finishConsentAllow,
  finishConsentDeny,
  finishLoginInteraction,
  mintProvisionalForInteraction,
  preferredProviderForDetails,
} from "../interactions/handlers.js";
import { beginOAuth2Auth, completeOAuth2Auth } from "../interactions/oauth2.js";
import {
  type ProviderDescriptor,
  normalizeIssuer,
  providerById,
  providerByIssuer,
} from "../interactions/registry.js";
import { resolveTrustedIssuer } from "../interactions/trust.js";
import type {
  InteractionDetails,
  ProviderInteractions,
} from "../interactions/types.js";
import type { Variables } from "../middleware/context.js";
import { claimPageSecurityHeaders } from "../middleware/security-headers.js";
import { emailLinkFields } from "../services/email-authority.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import { renderConsentPage, renderLoginPage } from "../ui/interaction-pages.js";
import { createByoInteractionRoutes } from "./interactions-byo.js";
import { createEmailInteractionRoutes } from "./interactions-email.js";
import { createLdapInteractionRoutes } from "./interactions-ldap.js";
import { createOrgInteractionRoutes } from "./interactions-org.js";
import { createRealmInteractionRoutes } from "./interactions-realm.js";
import { createSamlInteractionRoutes } from "./interactions-saml.js";
import { jitJoinOrganization } from "./organizations.js";
import { ensurePersonalOnAuthenticatedSession } from "./projects.js";
import { provisionedRoleForSubject } from "./scim.js";

type NodeEnv = { Bindings: HttpBindings };

/** The upstream round-trip is interactive; ten minutes is generous for it. */
const FEDERATED_PENDING_TTL_SECONDS = 600;

/**
 * Loop guard for the opt-in auto-continue: present means this interaction
 * already spent its one silent hop, so every later GET renders the page.
 */
function autoContinueCookieName(uid: string): string {
  return `os.auto.${uid}`;
}

/**
 * Plain words for an upstream refusal code. Only the two codes with a
 * distinct meaning for the person get their own copy; everything else says
 * the provider stopped and what to do about it.
 */
function describeUpstreamRefusal(code: string): string {
  switch (code) {
    case "access_denied":
      return "The provider reported: access was denied. Try again, or choose another way in.";
    case "login_required":
      return "The provider needs you to sign in there first. Try again to go back.";
    default:
      return "Sign-in at the provider didn't finish. Try again, or choose another way in.";
  }
}

/**
 * The only parameters copied out of a `form_post` callback body (D3).
 *
 * An allowlist, not a filter: everything else a provider posts — `user`,
 * `id_token`, anything a future revision adds — is dropped rather than
 * reflected into a URL this server then redirects the browser to.
 */
const FORM_POST_CALLBACK_PARAMS = [
  "code",
  "state",
  "error",
  "error_description",
] as const;

/**
 * Length cap for a re-materialized parameter. Authorization codes are a few
 * hundred bytes; anything near this is not a code, and a redirect URL
 * assembled from unbounded form input is a denial-of-service in a header.
 */
const MAX_FORM_POST_PARAM_LENGTH = 2048;

function interactionPath(uid: string): string {
  return `/interaction/${encodeURIComponent(uid)}`;
}

function providerInteractions(
  provider: OpenSesameProviderBundle["provider"],
): ProviderInteractions {
  // SAFETY: panva's Provider implements Grant.find/new, interactionDetails,
  // and interactionResult; the Client generic is unused at this boundary.
  return overlapCast(provider);
}

function nodeHttp(c: {
  env: HttpBindings;
}): { req: IncomingMessage; res: ServerResponse } | undefined {
  const req = c.env?.incoming;
  const res = c.env?.outgoing;
  if (!req || !res) return undefined;
  return { req, res };
}

/**
 * The registry descriptor a start request names: by id when a catalog button
 * posted one, by issuer for the legacy form. Both are re-resolved here against
 * the static registry and re-fenced inside the leg by `resolveTrustedIssuer`
 * (C2) — the rendered buttons are a convenience, never the fence.
 */
function requestedProvider(
  ctx: AppContext,
  providerId: string,
  issuer: string,
): ProviderDescriptor | undefined {
  if (providerId) return providerById(ctx.config, providerId);
  if (issuer) return providerByIssuer(ctx.config, issuer);
  return undefined;
}

/**
 * Complete whichever leg started this (C3/C4).
 *
 * `kind` rides in the pending cookie and an absent one means `"oidc"` — the
 * shape of every cookie written before this release. An `"oauth2"` pending
 * must never be finished by the OIDC leg: that leg's whole guarantee is a
 * JWKS-verified id_token, and a provider that issues none would otherwise be
 * admitted on whatever its token endpoint happened to return.
 */
async function completeFederatedLeg(
  ctx: AppContext,
  pending: PendingFederatedAuth,
  currentUrl: URL,
): Promise<FederatedIdentity> {
  if ((pending.kind ?? "oidc") !== "oauth2") {
    return completeFederatedAuth(ctx, pending, currentUrl);
  }
  const descriptor = pending.providerId
    ? providerById(ctx.config, pending.providerId)
    : undefined;
  if (
    !descriptor ||
    descriptor.kind !== "oauth2" ||
    normalizeIssuer(descriptor.issuer) !== normalizeIssuer(pending.issuer)
  ) {
    // The cookie named a provider this deployment no longer offers, or one
    // whose issuer it does not match. Either way, nothing vouches for it.
    throw new FederatedAuthError(
      "untrusted_issuer",
      "That sign-in provider is not trusted by this server",
    );
  }
  return completeOAuth2Auth(ctx, descriptor, pending, currentUrl);
}

/**
 * The oidc-provider interaction slot (ADR 0050 F6). `/auth` 303-redirects
 * here when login or consent is needed; `devInteractions` stays off. The
 * routes sit behind the same HTML security-header posture as the claim
 * verify page, and every POST requires the synchronizer CSRF token the
 * matching GET rendered.
 */
export function createInteractionRoutes(): Hono<
  { Variables: Variables } & NodeEnv
> {
  const routes = new Hono<{ Variables: Variables } & NodeEnv>();
  const csrf = createInteractionCsrf();

  routes.use("*", claimPageSecurityHeaders());

  /*
   * C9 sub-routers, mounted after the security headers so the hosted-page
   * posture covers them too. Each owns one route on this prefix and
   * re-implements the small `loadDetails` helper locally, so the files stay
   * disjoint.
   */
  routes.route("/", createByoInteractionRoutes(csrf));
  routes.route("/", createEmailInteractionRoutes(csrf));
  routes.route("/", createLdapInteractionRoutes(csrf));
  routes.route("/", createOrgInteractionRoutes(csrf));
  routes.route("/", createRealmInteractionRoutes(csrf));
  routes.route("/", createSamlInteractionRoutes(csrf));

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
    const http = nodeHttp(c);
    if (!http) {
      return {
        error: "OIDC interactions require the Node HTTP adapter",
        status: 501,
      };
    }
    try {
      const details = await provider.interactionDetails(http.req, http.res);
      return { http, details };
    } catch {
      return { error: "Interaction not found or expired", status: 404 };
    }
  }

  function verifyCsrf(uid: string, fields: JsonObject): boolean {
    const submitted = isString(fields._csrf) ? fields._csrf : undefined;
    return csrf.verify(uid, submitted);
  }

  routes.get("/:uid", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const loaded = await loadDetails(c, provider);
    if ("error" in loaded) {
      return c.text(loaded.error, loaded.status);
    }
    const { details } = loaded;
    const csrfToken = csrf.issue(details.uid);

    if (details.prompt.name === "login") {
      // `?org=<slug>` is the second step of organization sign-in (D6): the
      // slug form 303s back here and the model renders that tenant's methods.
      const orgSlug = c.req.query("org");
      const fedErrorCode = c.req.query("fed_error");

      // Opt-in auto-continue: the relying party already named the provider,
      // so the hinted leg starts without a second click. The per-interaction
      // cookie is the loop guard T14 demands: it is set before the redirect,
      // so a refusal that comes back (as ?fed_error) — or any second visit —
      // renders the full page instead of bouncing again. No CSRF token is
      // involved because no form authority is being spent: this is the
      // server acting on its own GET, and /federated/start's trust fence
      // still decides what may be federated to.
      if (
        ctx.config.interactionAutoContinue &&
        fedErrorCode === undefined &&
        orgSlug === undefined &&
        getCookie(c, autoContinueCookieName(details.uid)) === undefined
      ) {
        const preferred = preferredProviderForDetails(ctx, details);
        if (preferred) {
          try {
            const { authorizationUrl, pending } =
              preferred.kind === "oauth2"
                ? await beginOAuth2Auth(ctx, details.uid, preferred)
                : await beginFederatedAuth(ctx, details.uid, preferred.issuer);
            setCookie(c, autoContinueCookieName(details.uid), "1", {
              httpOnly: true,
              sameSite: "Lax",
              path: interactionPath(details.uid),
              maxAge: FEDERATED_PENDING_TTL_SECONDS,
              secure: ctx.config.publicUrl.startsWith("https://"),
            });
            setCookie(
              c,
              pendingCookieName(details.uid),
              encodePending(pending),
              {
                httpOnly: true,
                sameSite: "Lax",
                path: interactionPath(details.uid),
                maxAge: FEDERATED_PENDING_TTL_SECONDS,
                secure: ctx.config.publicUrl.startsWith("https://"),
              },
            );
            return c.redirect(authorizationUrl, 303);
          } catch (error) {
            // A leg that cannot start renders the page like always — the
            // silent fallback here is to the CHOICE, never past it.
            if (!(error instanceof FederatedAuthError)) throw error;
          }
        }
      }

      return c.html(
        renderLoginPage(
          await buildLoginPageModel(
            ctx,
            details,
            csrfToken,
            c.get("principalId"),
            {
              ...(orgSlug !== undefined ? { orgSlug } : undefined),
              ...(fedErrorCode !== undefined
                ? { federatedError: describeUpstreamRefusal(fedErrorCode) }
                : undefined),
            },
          ),
        ),
      );
    }
    if (details.prompt.name === "consent") {
      const model = await buildConsentPageModel(ctx, details, csrfToken);
      return c.html(renderConsentPage(model));
    }
    return c.text(
      `Unsupported interaction prompt: ${details.prompt.name}`,
      501,
    );
  });

  routes.post("/:uid/login", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const uid = c.req.param("uid");
    const fields = overlapCast(await c.req.parseBody());
    if (!verifyCsrf(uid, fields)) {
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

    const action = isString(fields.action) ? fields.action : "";
    let accountId: string;
    if (action === "continue") {
      // The account comes from the authenticated session cookie, never from
      // a form field — a posted id would be an unauthenticated account choice.
      const principalId = c.get("principalId");
      if (!principalId) {
        return c.json({ error: "login_required" }, 401);
      }
      accountId = principalId;
    } else if (action === "start") {
      const fingerprint = createHash("sha256")
        .update(c.req.header("user-agent") ?? "")
        .update("|")
        .update(c.req.header("origin") ?? "")
        .digest("hex")
        .slice(0, 16);
      try {
        const minted = await mintProvisionalForInteraction(
          ctx,
          fingerprint,
          c.get("correlationId"),
        );
        accountId = minted.principalId;
        setCookie(c, ctx.config.provisionalCookieName, minted.accessToken, {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
          secure: ctx.config.publicUrl.startsWith("https://"),
        });
      } catch (error) {
        if (error instanceof ProvisionalMintRefusedError) {
          return c.json({ error: error.code }, 429);
        }
        throw error;
      }
    } else {
      return c.text("Unknown login action", 400);
    }

    const returnTo = await finishLoginInteraction(
      provider,
      http.req,
      http.res,
      accountId,
    );
    return c.redirect(returnTo, 303);
  });

  /**
   * Hand the browser to a trusted upstream (ADR 0033 §4, ADR 0055).
   *
   * The provider arrives as a form field — `provider` (a registry id, which
   * wins) or the legacy `issuer` — and both are re-validated server-side, here
   * against the static registry and again inside the leg by
   * `resolveTrustedIssuer`. The rendered buttons are a convenience, not the
   * fence. The leg state rides in a cookie scoped to this interaction.
   */
  routes.post("/:uid/federated/start", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const uid = c.req.param("uid");
    const fields = overlapCast(await c.req.parseBody());
    if (!verifyCsrf(uid, fields)) {
      return c.text("Invalid or expired CSRF token", 403);
    }
    const loaded = await loadDetails(c, provider);
    if ("error" in loaded) {
      return c.text(loaded.error, loaded.status);
    }
    if (loaded.details.prompt.name !== "login") {
      return c.text("Prompt mismatch", 400);
    }

    const providerId = isString(fields.provider) ? fields.provider.trim() : "";
    const issuer = isString(fields.issuer) ? fields.issuer : "";
    const descriptor = requestedProvider(ctx, providerId, issuer);
    if (providerId && !descriptor) {
      // A named provider that resolves to nothing is not a legacy issuer to
      // fall back on: it is a request for a provider this server does not
      // offer, and falling through would sign the user in somewhere else.
      return c.text("That sign-in provider is not trusted by this server", 403);
    }

    try {
      const { authorizationUrl, pending } =
        descriptor?.kind === "oauth2"
          ? await beginOAuth2Auth(ctx, uid, descriptor)
          : await beginFederatedAuth(ctx, uid, descriptor?.issuer ?? issuer);
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
        return c.text(
          error.message,
          error.code === "untrusted_issuer" ? 403 : 502,
        );
      }
      throw error;
    }
  });

  /**
   * `response_mode=form_post` re-materialization (D3, T4).
   *
   * Apple returns the authorization response as a cross-site POST from
   * `appleid.apple.com`. Both the `os.fed.<uid>` pending cookie and
   * oidc-provider's interaction cookie are `SameSite=Lax`, so NEITHER is on
   * that request — a handler that completed the sign-in here would pass a
   * same-origin test and fail against real Apple every single time.
   *
   * So this route does no completion work at all. It copies four allowlisted
   * parameters into a 303 to the GET callback; the browser then makes a
   * top-level same-site GET, which does carry both cookies, and the existing
   * callback runs unchanged. There is no CSRF token because there is no
   * authority here to abuse: the redirect target is this server's own
   * callback, and `state` byte-equality against the pending cookie is still
   * the binding that decides whether anything completes.
   */
  routes.post("/:uid/federated/callback", async (c) => {
    const uid = c.req.param("uid");
    const fields = overlapCast(await c.req.parseBody());
    const params = new URLSearchParams();
    for (const name of FORM_POST_CALLBACK_PARAMS) {
      const value = fields[name];
      if (!isString(value) || value.length === 0) continue;
      if (value.length > MAX_FORM_POST_PARAM_LENGTH) continue;
      params.set(name, value);
    }
    const query = params.toString();
    return c.redirect(
      `${interactionPath(uid)}/federated/callback${query ? `?${query}` : ""}`,
      303,
    );
  });

  /**
   * Upstream return. No CSRF token here: the pending cookie's `state` is the
   * binding, and openid-client rejects the exchange unless the upstream echoes
   * it. The route must live under `/interaction/:uid` because the provider's
   * interaction cookie is path-scoped there.
   */
  routes.get("/:uid/federated/callback", async (c) => {
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

    const pending = decodePending(getCookie(c, pendingCookieName(uid)));
    // Single-use: drop it before the exchange so a replayed callback cannot
    // re-run the code, whatever the outcome below.
    deleteCookie(c, pendingCookieName(uid), { path: interactionPath(uid) });

    // A refusal upstream is a normal outcome — return to the login page so the
    // user can pick another provider or start a plain session. The CODE (never
    // the upstream's free text) rides along so the page can say what happened
    // instead of silently looking like a broken button.
    const upstreamError = c.req.query("error");
    if (upstreamError) {
      const code = /^[a-z0-9_]{1,40}$/.test(upstreamError)
        ? upstreamError
        : "upstream_error";
      return c.redirect(
        `${interactionPath(uid)}?fed_error=${encodeURIComponent(code)}`,
        303,
      );
    }
    if (!pending) {
      return c.text(
        "Sign-in state did not match. Start the sign-in again.",
        400,
      );
    }

    let identity: FederatedIdentity;
    try {
      identity = await completeFederatedLeg(ctx, pending, new URL(c.req.url));
    } catch (error) {
      if (error instanceof FederatedAuthError) {
        return c.text(
          error.message,
          error.code === "untrusted_issuer" ? 403 : 400,
        );
      }
      throw error;
    }

    // Resolved again rather than carried from the leg: the same read decides
    // both what may be federated to and what its email claim is worth, and a
    // value threaded through the pending cookie would be one a forged cookie
    // could choose.
    const trust = await resolveTrustedIssuer(ctx, identity.issuer);
    if (!trust) {
      return c.text("That sign-in provider is not trusted by this server", 403);
    }

    const correlationId = c.get("correlationId");
    const existing = await ctx.repos.externalIdentities.findByTuple({
      kind: identity.kind,
      issuer: identity.issuer,
      subject: identity.subject,
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
      // Brand-new user: mint the same provisional principal the "Start a
      // session" action would, then promote it in place by attaching the
      // verified identity. The principal id never changes (ADR 0033).
      const fingerprint = createHash("sha256")
        .update(c.req.header("user-agent") ?? "")
        .update("|")
        .update(ctx.config.publicUrl)
        .digest("hex")
        .slice(0, 16);
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

      const attached = await attachVerifiedExternalIdentity(
        ctx,
        minted.principalId,
        {
          kind: identity.kind,
          issuer: identity.issuer,
          subject: identity.subject,
          correlationId,
          ...(identity.name !== undefined
            ? { displayHint: identity.name }
            : undefined),
          /*
           * Whether this upstream's `email_verified` may JOIN accounts, not
           * just whether it said so. The trust fence admits issuers a visitor
           * registered themselves through the bring-your-own form; honouring
           * their email claim would let anyone who can run an OIDC server sign
           * in as any existing user (ADR 0057 §1a). The address is still
           * recorded either way.
           */
          ...(await emailLinkFields(
            ctx,
            trust,
            identity.email,
            identity.emailVerified,
          )),
        },
      );
      if (!attached.ok) {
        return c.text(attached.message, 409);
      }
      // The verified-email policy (D15) may have attached this identity to a
      // principal that already existed, in which case the principal minted a
      // moment ago is not the account signing in. Follow the identity row,
      // never the mint — the alternative is signing somebody in as a guest
      // that carries none of their history.
      accountId = attached.identity.principalId;
      // The same first-authenticated-session guarantee POST
      // /v1/principals/link-identities gives: a principal that just became
      // verified gets its personal project. Both federated surfaces have to
      // agree here, or where you signed in decides whether you have one.
      await ensurePersonalOnAuthenticatedSession(ctx, accountId, correlationId);
      if (accountId === minted.principalId) {
        // The minted session belongs to the minted principal and to nothing
        // else. When D15 sent the identity to an existing principal instead,
        // this browser is a returning user (T6) and gets no cookie here —
        // handing it the throwaway principal's bearer would leave it holding
        // a session for an account the interaction did not complete as.
        setCookie(c, ctx.config.provisionalCookieName, minted.accessToken, {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
          secure: ctx.config.publicUrl.startsWith("https://"),
        });
      }
    }

    // A bring-your-own upstream that just signed somebody in is in use, and
    // the admin surface lists records by last use (D14).
    if (pending.byoId) {
      await ctx.repos.byoUpstreams.touchLastUsed(pending.byoId, ctx.clock());
    }

    // Organization sign-in JIT-joins on completion (D6): the tenant's own IdP
    // vouched for this subject, so membership follows the sign-in rather than
    // waiting for a separate join call. Refused when the tenant provisions
    // through a directory and this subject is not in it (C15) — the sign-in
    // itself already happened, and refusing here is what keeps a
    // deprovisioned employee out of the tenant.
    if (pending.orgId) {
      const organization = await ctx.stores.organizations.get(pending.orgId);
      if (organization) {
        // A directory that pushed this subject into an owners group said so
        // before the sign-in happened, and that is the tenant's answer about
        // its own people — so it decides the role rather than `member` (C15).
        const role = await provisionedRoleForSubject(
          ctx,
          organization.id,
          identity.subject,
        );
        const joined = await jitJoinOrganization(ctx, {
          organization,
          principalId: accountId,
          subject: identity.subject,
          method: "sso",
          correlationId,
          ...(role !== undefined ? { role } : undefined),
        });
        if (!joined.ok) {
          return c.text(joined.message, 403);
        }
      }
    }

    const returnTo = await finishLoginInteraction(
      provider,
      http.req,
      http.res,
      accountId,
    );
    return c.redirect(returnTo, 303);
  });

  routes.post("/:uid/confirm", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const uid = c.req.param("uid");
    const fields = overlapCast(await c.req.parseBody());
    if (!verifyCsrf(uid, fields)) {
      return c.text("Invalid or expired CSRF token", 403);
    }
    const loaded = await loadDetails(c, provider);
    if ("error" in loaded) {
      return c.text(loaded.error, loaded.status);
    }
    const { http, details } = loaded;
    if (details.prompt.name !== "consent") {
      return c.text("Prompt mismatch", 400);
    }
    if (!details.session?.accountId) {
      return c.json({ error: "login_required" }, 401);
    }

    const returnTo = await finishConsentAllow(
      ctx,
      provider,
      http.req,
      http.res,
      details,
      c.get("correlationId"),
    );
    return c.redirect(returnTo, 303);
  });

  routes.post("/:uid/abort", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const uid = c.req.param("uid");
    const fields = overlapCast(await c.req.parseBody());
    if (!verifyCsrf(uid, fields)) {
      return c.text("Invalid or expired CSRF token", 403);
    }
    const loaded = await loadDetails(c, provider);
    if ("error" in loaded) {
      return c.text(loaded.error, loaded.status);
    }
    const { http, details } = loaded;

    const returnTo = await finishConsentDeny(
      ctx,
      provider,
      http.req,
      http.res,
      details,
      c.get("correlationId"),
    );
    return c.redirect(returnTo, 303);
  });

  return routes;
}
