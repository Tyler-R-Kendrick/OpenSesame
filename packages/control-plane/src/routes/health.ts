import { Hono } from "hono";
import type { Variables } from "../middleware/context.js";

export const healthRoutes = new Hono<{ Variables: Variables }>();

healthRoutes.get("/live", (c) => c.json({ status: "ok" }));

healthRoutes.get("/ready", async (c) => {
  const ctx = c.get("ctx");
  if (!ctx.ready || !(await ctx.securityStateReady())) {
    return c.json({ status: "not_ready" }, 503);
  }
  return c.json({ status: "ready" });
});
