import { appendAuditEvent } from "@opensesame/audit";
import { ReleaseSectorClaimRequestSchema } from "@opensesame/contracts";
import { pairwiseSectorKey } from "@opensesame/oauth-provider";
import type { BoundaryValue } from "@opensesame/os-domain";
import { Hono } from "hono";
import { requireOperatorToken } from "../middleware/admin-auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";

/**
 * Operator release of a pairwise sector key (a squatted sector).
 *
 * A sector key goes to the first owner to register under it, and stays with
 * them even once their clients are revoked, because their users' subjects
 * under that key were already seen. So a principal who registered someone
 * else's sector first holds it for good, and revoking their clients changes
 * nothing. This is the way out, and only the deployment operator may take it
 * (server-only operator token, like the origin-client admin routes): it is
 * the one action that moves a sector between owners.
 *
 * The store blocks every client on the key (`sector_released`: the pairwise
 * callback refuses them), bumps the key's claim generation and leaves the key
 * unheld — or held for `nextOwnerPrincipalId`, so the real owner registers
 * before anyone can re-take it. The next holder's clients record the new
 * generation, which the pairwise subject sector mixes in, so they start from
 * fresh subjects: none of them can meet a `sub` the previous holder's users
 * were issued. Every release is chained-audited with the operator's reason.
 */
export const oauthSectorAdminRoutes = new Hono<{ Variables: Variables }>();

oauthSectorAdminRoutes.post(
  "/release",
  requireOperatorToken(),
  idempotencyMiddleware("admin.oauth-sector.release"),
  async (c) => {
    const ctx = c.get("ctx");
    let body: BoundaryValue;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const parsed = ReleaseSectorClaimRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const sectorKey = pairwiseSectorKey(parsed.data.sectorIdentifier);
    const next = parsed.data.nextOwnerPrincipalId;
    if (next && !(await ctx.repos.principals.getById(next))) {
      return c.json(
        { error: "not_found", message: "No such next owner principal" },
        404,
      );
    }
    const released = await ctx.stores.oauthClients.releaseSectorKey(
      sectorKey,
      next,
    );
    if (!released) {
      return c.json(
        { error: "not_found", message: "No owner holds this sector key" },
        404,
      );
    }
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "oauth_client.sector_released",
      outcome: "succeeded",
      actorType: "system",
      actorId: "operator",
      targetType: "oauth_sector",
      targetId: sectorKey,
      // A named next owner is the principal this event hands the key to.
      ...(next ? { principalId: next } : undefined),
      correlationId: c.get("correlationId"),
      // Keys from the audit allowlist: the released key, the holder it was
      // taken from, how many clients lost it, and the generation it moved to.
      metadata: {
        action: "oauth_client.admin_sector_release",
        reason: parsed.data.reason,
        sectorIdentifier: sectorKey,
        subjectId: released.previousOwnerKey,
        count: released.blockedClientIds.length,
        contentVersion: released.generation,
        toState: next ? "held_for_next_owner" : "open",
      },
    });
    return c.json({
      sectorKey,
      generation: released.generation,
      previousOwnerKey: released.previousOwnerKey,
      blockedClientIds: released.blockedClientIds,
      nextOwnerPrincipalId: released.nextOwnerKey,
    });
  },
);
