import type { HttpBindings } from "@hono/node-server";
import { isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  SamlAuthError,
  admitSamlSubject,
  auditIdpInitiated,
  completeSamlResponse,
  samlServiceProviderMetadata,
} from "../interactions/saml.js";
import type { Variables } from "../middleware/context.js";

type NodeEnv = { Bindings: HttpBindings };

/**
 * One answer for every refusal (D10).
 *
 * The ACS is an unauthenticated endpoint anybody can POST to. "Unknown
 * request", "bad signature", "wrong audience" and "already used" are four
 * different facts about our state, and answering them differently would let a
 * stranger map which organizations exist, which requests are outstanding, and
 * which assertions have already been spent. The details go to the log, with a
 * correlation id the operator can quote.
 */
const ACS_REFUSAL = "That sign-in could not be completed.";

/**
 * Native SAML SP endpoints (C14): metadata and the assertion consumer service.
 *
 * Mounted at `/v1/saml`. Neither route is CSRF-protected and neither can be:
 * the ACS is a cross-site POST from the IdP by definition, which is exactly
 * why it carries no cookie and no synchronizer token could reach it (T25). The
 * signature over the assertion is the authority here, and the pending record —
 * server-side, single-use — is what binds it to a request we made.
 */
export function createSamlRoutes(): Hono<{ Variables: Variables } & NodeEnv> {
  const routes = new Hono<{ Variables: Variables } & NodeEnv>();

  routes.get("/metadata", (c) => {
    const ctx = c.get("ctx");
    return c.body(samlServiceProviderMetadata(ctx.config), 200, {
      "content-type": "application/samlmetadata+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
  });

  routes.post("/acs", async (c) => {
    const ctx = c.get("ctx");
    const correlationId = c.get("correlationId");
    const fields = overlapCast(await c.req.parseBody());
    const samlResponse = isString(fields.SAMLResponse)
      ? fields.SAMLResponse
      : "";
    const relayState = isString(fields.RelayState)
      ? fields.RelayState
      : undefined;
    if (samlResponse.length === 0) {
      return c.text(ACS_REFUSAL, 400);
    }

    let outcome: Awaited<ReturnType<typeof completeSamlResponse>>;
    try {
      outcome = await completeSamlResponse(ctx, {
        SAMLResponse: samlResponse,
        ...(relayState !== undefined ? { RelayState: relayState } : undefined),
      });
    } catch (error) {
      if (error instanceof SamlAuthError) {
        ctx.log.warn(
          { code: error.code, correlationId },
          "saml assertion refused",
        );
        return c.text(ACS_REFUSAL, 400);
      }
      throw error;
    }

    if (outcome.flow === "sp") {
      // Hand the browser back to the interaction on a top-level GET, which
      // DOES carry the Lax interaction cookie this POST could not (T25). The
      // code names an assertion this process just verified and is single-use.
      return c.redirect(
        `/interaction/${encodeURIComponent(outcome.interactionUid)}` +
          `/federated/saml/complete?otc=${encodeURIComponent(outcome.completionCode)}`,
        303,
      );
    }

    // IdP-initiated (D10): there is no interaction to resume, so this leg owns
    // the whole admission — find-or-mint, JIT-join, and the session cookie.
    const admitted = await admitSamlSubject(ctx, {
      result: outcome.result,
      correlationId,
      userAgent: c.req.header("user-agent") ?? "",
    });
    if (!admitted.ok) {
      if (admitted.status === 429) {
        return c.json({ error: admitted.message }, 429);
      }
      return c.text(admitted.message, admitted.status);
    }
    await auditIdpInitiated(ctx, {
      principalId: admitted.principalId,
      result: outcome.result,
      issuer: admitted.issuer,
      correlationId,
    });
    if (admitted.sessionToken !== undefined) {
      setCookie(c, ctx.config.provisionalCookieName, admitted.sessionToken, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
        secure: ctx.config.publicUrl.startsWith("https://"),
      });
    }
    return c.redirect(outcome.relayPath, 303);
  });

  return routes;
}
