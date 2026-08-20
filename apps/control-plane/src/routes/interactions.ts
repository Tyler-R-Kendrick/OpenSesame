import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { createInteractionCsrf } from "../interactions/csrf.js";
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
import { renderConsentPage, renderLoginPage } from "../ui/interaction-pages.js";
import { type JsonObject, overlapCast, isString } from "@opensesame/os-domain";

type NodeEnv = { Bindings: HttpBindings };

function providerInteractions(provider: ProviderInteractions): ProviderInteractions {
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
      const details = overlapCast(await provider.interactionDetails(
        http.req,
        http.res,
      ));
      return { http, details };
    } catch {
      return { error: "Interaction not found or expired", status: 404 };
    }
  }

  function verifyCsrf(uid: string, fields: JsonObject): boolean {
    const submitted =
      isString(fields._csrf) ? fields._csrf : undefined;
    return csrf.verify(uid, submitted);
  }

  routes.get("/:uid", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(
      overlapCast(ctx.oauth.provider),
    );
    const loaded = await loadDetails(c, provider);
    if ("error" in loaded) {
      return c.text(loaded.error, loaded.status);
    }
    const { details } = loaded;
    const csrfToken = csrf.issue(details.uid);

    if (details.prompt.name === "login") {
      return c.html(
        renderLoginPage(
          buildLoginPageModel(ctx, details, csrfToken, c.get("principalId")),
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
    const provider = providerInteractions(
      overlapCast(ctx.oauth.provider),
    );
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

  routes.post("/:uid/confirm", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(
      overlapCast(ctx.oauth.provider),
    );
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
    const provider = providerInteractions(
      overlapCast(ctx.oauth.provider),
    );
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
