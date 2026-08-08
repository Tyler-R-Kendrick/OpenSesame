import { Hono } from "hono";
import type { Variables } from "../middleware/context.js";
import { requirePrincipal } from "../middleware/auth.js";

/**
 * Device authorization approval — Identity plane proxy to Host API.
 * Browsers must never hold OPENSESAME_OPERATOR_TOKEN; the control-plane injects it server-side.
 */
export const deviceRoutes = new Hono<{ Variables: Variables }>();

deviceRoutes.post("/approve", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  if (!ctx.config.operatorToken) {
    return c.json(
      {
        error: "operator_token_unconfigured",
        hint: "Set OPENSESAME_OPERATOR_TOKEN on the Identity API",
      },
      503,
    );
  }
  const body = await c.req.json<{ user_code?: string; principal?: string }>();
  const userCode = body.user_code?.trim();
  if (!userCode) {
    return c.json({ error: "invalid_request", hint: "user_code required" }, 400);
  }
  const url = `${ctx.config.hostApiUrl}/api/v1/device/approve`;
  try {
    const parsed = new URL(ctx.config.hostApiUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return c.json({ error: "invalid_host_api_url" }, 500);
    }
    if (parsed.username || parsed.password) {
      return c.json({ error: "invalid_host_api_url", hint: "credentials in URL denied" }, 500);
    }
  } catch {
    return c.json({ error: "invalid_host_api_url" }, 500);
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opensesame-operator": ctx.config.operatorToken,
      },
      body: JSON.stringify({
        user_code: userCode,
        // Always bind to the authenticated Identity principal — never trust client-supplied principal.
        principal: principalId,
      }),
    });
    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      /* keep text */
    }
    // `url` is deliberately not echoed: the Host API address is internal
    // topology, and callers only need the approval outcome.
    return c.json(
      {
        ok: res.ok,
        status: res.status,
        body: payload,
      },
      res.ok ? 200 : res.status === 404 ? 404 : 502,
    );
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "device approve proxy failed",
    );
    return c.json(
      {
        error: "host_api_unreachable",
        hint: "Is Host API up on OPENSESAME_HOST_API / OPENSESAME_SERVER?",
      },
      502,
    );
  }
});
