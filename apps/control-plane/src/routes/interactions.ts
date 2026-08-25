import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createInteractionCsrf } from "../interactions/csrf.js";
import {
  FederatedAuthError,
  type FederatedIdentity,
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
} from "../interactions/handlers.js";
import type {
  InteractionDetails,
  ProviderInteractions,
} from "../interactions/types.js";
import type { Variables } from "../middleware/context.js";
import { claimPageSecurityHeaders } from "../middleware/security-headers.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import { renderConsentPage, renderLoginPage } from "../ui/interaction-pages.js";
import { ensurePersonalOnAuthenticatedSession } from "./projects.js";

type NodeEnv = { Bindings: HttpBindings };

/** The upstream round-trip is interactive; ten minutes is generous for it. */
const FEDERATED_PENDING_TTL_SECONDS = 600;

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
      return c.html(
        renderLoginPage(
          await buildLoginPageModel(
            ctx,
            details,
            csrfToken,
            c.get("principalId"),
            { ...(orgSlug !== undefined ? { orgSlug } : undefined) },
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
   * Hand the browser to a trusted upstream (ADR 0033 §4). The issuer arrives
   * as a form field and is re-checked against the allowlist inside
   * `beginFederatedAuth` — the rendered buttons are a convenience, not the
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

    const issuer = isString(fields.issuer) ? fields.issuer : "";
    try {
      const { authorizationUrl, pending } = await beginFederatedAuth(
        ctx,
        uid,
        issuer,
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
        return c.text(
          error.message,
          error.code === "untrusted_issuer" ? 403 : 502,
        );
      }
      throw error;
    }
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
    // user can pick another provider or start a plain session.
    if (c.req.query("error")) {
      return c.redirect(interactionPath(uid), 303);
    }
    if (!pending) {
      return c.text(
        "Sign-in state did not match. Start the sign-in again.",
        400,
      );
    }

    let identity: FederatedIdentity;
    try {
      identity = await completeFederatedAuth(ctx, pending, new URL(c.req.url));
    } catch (error) {
      if (error instanceof FederatedAuthError) {
        return c.text(
          error.message,
          error.code === "untrusted_issuer" ? 403 : 400,
        );
      }
      throw error;
    }

    const correlationId = c.get("correlationId");
    const existing = await ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
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
          issuer: identity.issuer,
          subject: identity.subject,
          correlationId,
          ...(identity.name !== undefined
            ? { displayHint: identity.name }
            : undefined),
          ...(identity.email !== undefined
            ? { emailNormalized: identity.email }
            : undefined),
          ...(identity.emailVerified !== undefined
            ? { emailVerified: identity.emailVerified }
            : undefined),
        },
      );
      if (!attached.ok) {
        return c.text(attached.message, 409);
      }
      accountId = minted.principalId;
      // The same first-authenticated-session guarantee POST
      // /v1/principals/link-identities gives: a principal that just became
      // verified gets its personal project. Both federated surfaces have to
      // agree here, or where you signed in decides whether you have one.
      await ensurePersonalOnAuthenticatedSession(
        ctx,
        minted.principalId,
        correlationId,
      );
      setCookie(c, ctx.config.provisionalCookieName, minted.accessToken, {
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
