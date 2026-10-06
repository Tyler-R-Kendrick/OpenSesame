/**
 * Runs a route handler under a `VerifiedPrincipal` proof (ADR 0178).
 *
 * The caller is named for one callback, and the handler is generic in that
 * name, so it cannot return or store it. Each route passes the refusal it has
 * always sent: the proof decides, the route words the answer.
 */

import type { Named } from "@gdp-ts/core";
import { name } from "@gdp-ts/core";
import type { Principal } from "@opensesame/os-domain";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import { type ActorId, actorId } from "../lib/ids.js";
import type { Variables } from "../middleware/context.js";
import {
  type VerifiedPrincipal,
  type VerifiedRefusalReason,
  verifiedPrincipal,
} from "../proofs/verified-principal.js";

export interface VerifiedGate<A> {
  readonly ctx: AppContext;
  readonly actor: Named<A, ActorId>;
  readonly proof: VerifiedPrincipal<A>;
  readonly principal: Principal;
}

export type VerifiedHandler<R> = <A>(gate: VerifiedGate<A>) => Promise<R>;

export type VerifiedRefusal = (reason: VerifiedRefusalReason) => Response;

/**
 * The refusal `oauth-clients`, `app-claims` and `organizations` share:
 * `404 not_found` for an unknown principal, `403 assurance_too_low` carrying the
 * route's own message for a provisional one.
 */
export function assuranceRefusal(message: string): VerifiedRefusal {
  return (reason) =>
    reason === "not_found"
      ? Response.json({ error: "not_found" }, { status: 404 })
      : Response.json({ error: "assurance_too_low", message }, { status: 403 });
}

/** Runs `handler` for a verified caller; any refusal is the route's own. */
export async function asVerifiedPrincipalOr<R>(
  c: Context<{ Variables: Variables }>,
  refuse: VerifiedRefusal,
  handler: VerifiedHandler<R>,
): Promise<R | Response> {
  const ctx = c.get("ctx");
  return name(actorId(c.get("principalId")), async (actor) => {
    const verdict = await verifiedPrincipal(ctx.repos, actor);
    if (!verdict.ok) return refuse(verdict.reason);
    return handler({
      ctx,
      actor,
      proof: verdict.proof,
      principal: verdict.principal,
    });
  });
}

/** The common case: `assuranceRefusal(message)` as the refusal. */
export function asVerifiedPrincipal<R>(
  c: Context<{ Variables: Variables }>,
  message: string,
  handler: VerifiedHandler<R>,
): Promise<R | Response> {
  return asVerifiedPrincipalOr(c, assuranceRefusal(message), handler);
}
