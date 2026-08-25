import { createHash } from "node:crypto";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import {
  type ByoRegistrationErrorCode,
  registerByoUpstream,
} from "../interactions/byo.js";
import { stableFederatedRedirectUri } from "../interactions/federated.js";
import type { Variables } from "../middleware/context.js";

/**
 * Visitor-facing JSON registration for bring-your-own OIDC issuers (C9/D5) —
 * the API twin of the hosted login page's `POST /interaction/:uid/federated/byo`
 * form, so a client app (Pages) can offer provider setup at registration.
 *
 * Everything that makes the form path safe lives in `registerByoUpstream` and
 * is reused untouched: the SSRF-fenced mandatory discovery, the issuer-match
 * check, RFC 7591 dynamic registration with the deployment-wide redirect URI,
 * the 5-per-10-minute abuse budget spent before the store lookup, and
 * idempotency by issuer that never overwrites a stored credential. The
 * response copies `byo-admin.ts`'s shaping: the client secret is never echoed
 * (ADR 0005). BYO issuers stay non-email-authoritative — nothing here can
 * grant an email-join (ADR 0055/0057).
 */

const ERROR_STATUS: Record<ByoRegistrationErrorCode, 422 | 429> = {
  invalid_issuer: 422,
  discovery_failed: 422,
  registration_unsupported: 422,
  rate_limited: 429,
};

export const byoPublicRoutes = new Hono<{ Variables: Variables }>();

byoPublicRoutes.post("/byo-upstreams", async (c) => {
  const ctx = c.get("ctx");
  let body: BoundaryValue;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request", message: "Send JSON." }, 400);
  }
  if (!isJsonObject(body) || !isString(body.issuer)) {
    return c.json(
      { error: "invalid_request", message: "An issuer URL is required." },
      400,
    );
  }
  const clientId = isString(body.clientId) ? body.clientId : undefined;
  const clientSecret = isString(body.clientSecret)
    ? body.clientSecret
    : undefined;

  // The same user-agent-derived abuse key the interaction's unauthenticated
  // POSTs mint. A fence against one browser hammering the endpoint, never an
  // identifier: nothing durable is keyed by it.
  const fingerprint = createHash("sha256")
    .update(c.req.header("user-agent") ?? "")
    .update("|")
    .update(c.req.header("origin") ?? "")
    .digest("hex")
    .slice(0, 16);

  const outcome = await registerByoUpstream(
    ctx,
    {
      issuer: body.issuer,
      ...(clientId !== undefined ? { clientId } : undefined),
      ...(clientSecret !== undefined ? { clientSecret } : undefined),
      // The DCR path registers the deployment-wide callback, never a caller-
      // supplied one: RFC 7591 registers a redirect_uri once and the IdP then
      // matches it exactly (ADR 0055).
      redirectUri: stableFederatedRedirectUri(ctx.config),
    },
    fingerprint,
  );

  if ("error" in outcome) {
    // The messages were written for an unauthenticated surface — reuse them
    // verbatim rather than growing a second, chattier set (SSRF probe oracle).
    return c.json(
      { error: outcome.error, message: outcome.message },
      ERROR_STATUS[outcome.error],
    );
  }

  const record = outcome.record;
  return c.json({
    id: record.id,
    issuer: record.issuer,
    label: record.label,
    clientId: record.clientId,
    clientAuth: record.clientAuth,
    registrationSource: record.registrationSource,
    // What the visitor registers at their own IdP when DCR was unavailable.
    redirectUri: stableFederatedRedirectUri(ctx.config),
  });
});
