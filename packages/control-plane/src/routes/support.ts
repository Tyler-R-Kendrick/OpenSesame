import { redactSupportQuestion } from "@opensesame/support-agent";
import { Hono } from "hono";
import { z } from "zod";
import type { Variables } from "../middleware/context.js";
import { supportProxySeams } from "../services/support-proxy.js";

const id = z
  .string()
  .regex(/^\/?[a-z][a-z0-9._/-]{0,63}$/)
  .refine((value) => !value.includes("//"));
const payload = z
  .object({
    version: z.literal(2),
    question: z.string().min(1).max(2000),
    pageId: id,
    route: id,
    featureIds: z.array(id).max(32),
  })
  .strict();
export const supportRoutes = new Hono<{ Variables: Variables }>();

const SUPPORT_WINDOW_MS = 60_000;
const SUPPORT_PER_SESSION = 6;
const supportBudget = new Map<string, number[]>();

function supportAllowed(key: string, now: number): boolean {
  const recent = (supportBudget.get(key) ?? []).filter(
    (at) => now - at < SUPPORT_WINDOW_MS,
  );
  if (recent.length >= SUPPORT_PER_SESSION) {
    supportBudget.set(key, recent);
    return false;
  }
  recent.push(now);
  supportBudget.set(key, recent);
  return true;
}

export function resetSupportBudgetForTest(): void {
  supportBudget.clear();
}
supportRoutes.use("*", async (c, next) => {
  const ctx = c.get("ctx");
  if (!ctx.config.supportProxy) return c.json({ error: "not_found" }, 404);
  if (!c.get("provisionalSessionId"))
    return c.json({ error: "unauthorized" }, 401);
  if (
    c.req.method === "POST" &&
    c.req.header("origin") !== new URL(ctx.config.publicUrl).origin
  )
    return c.json({ error: "forbidden" }, 403);
  c.header("Cache-Control", "no-store");
  return next();
});
supportRoutes.get("/", (c) => {
  c.header("X-OpenSesame-Support-Session", "active");
  return c.body(null, 204);
});
supportRoutes.post("/", async (c) => {
  const ctx = c.get("ctx");
  const config = ctx.config.supportProxy;
  if (!config) return c.json({ error: "not_found" }, 404);
  const session = c.get("provisionalSessionId");
  if (!session || !supportAllowed(session, ctx.clock().getTime()))
    return c.json({ error: "rate_limited" }, 429);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > 8192)
    return c.json({ error: "request_too_large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return c.json({ error: "validation_error" }, 400);
  }
  const checked = payload.safeParse(parsed);
  if (!checked.success) return c.json({ error: "validation_error" }, 400);
  try {
    const reply = await supportProxySeams.post(
      config,
      JSON.stringify({
        ...checked.data,
        question: redactSupportQuestion(checked.data.question),
      }),
      c.req.raw.signal,
    );
    if (reply.includes(config.token))
      throw new Error("Support credential echo refused");
    c.header("Content-Type", "text/event-stream");
    return c.body(reply);
  } catch {
    return c.json({ error: "support_unavailable" }, 502);
  }
});
