/**
 * Cross-device rendezvous admission (ADR 0086 §3).
 *
 * A persistent wallet address admits a *request*, never an approval. The
 * canonical ceremony lives at `/i/:ref`. This surface exists so scanners and
 * kiosks have an authenticated place to raise a short-lived interaction
 * against an opted-in address without mistaking the address for the holder.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";

const AdmitSchema = z.object({
  /** Pseudonymous public address the holder explicitly enabled. */
  addressId: z.string().min(8).max(128),
  /** Opaque requester-side correlation; never treated as principal proof. */
  requesterBinding: z.string().min(8).max(256),
});

/**
 * Mounted at `/v1/rendezvous`. Address resolution is fail-closed until a
 * registration records an enabled address; scanners never become the holder.
 */
export function createRendezvousRoutes(): Hono<{ Variables: Variables }> {
  const routes = new Hono<{ Variables: Variables }>();

  routes.get("/ping", (c) => c.json({ ok: true, surface: "rendezvous" }));

  /**
   * Probe a public address. Returns only whether admission is possible — never
   * owner identity, inbox contents, or pending interaction digests.
   */
  routes.get("/addresses/:addressId", async (c) => {
    const addressId = c.req.param("addressId") ?? "";
    if (addressId.length < 8 || addressId.length > 128) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // No durable address registry is wired yet: refuse rather than invent a
    // reachable inbox. Local disablement of a future address will flip this
    // to the same 404 a stranger gets for an unknown id.
    return c.json({ error: "address_unavailable" }, 404);
  });

  /**
   * Authenticated requester asks to raise an interaction against an address.
   * Without an enabled address registry this refuses closed.
   */
  routes.post("/admit", requirePrincipal(), async (c) => {
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const parsed = AdmitSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    void principalId;
    return c.json(
      {
        error: "address_unavailable",
        reason:
          "no enabled wallet address admits requests on this deployment; use /i/<ref> from a requester-displayed QR instead",
      },
      404,
    );
  });

  return routes;
}
