import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { appendAuditEvent } from "@opensesame/audit";
import {
  RegisterAgentRequestSchema,
  RegisterAgentResponseSchema,
} from "@opensesame/contracts";
import type { Agent, AgentInstance } from "@opensesame/os-domain";
import type { Variables } from "../middleware/context.js";
import { requirePrincipal } from "../middleware/auth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { bumpUsage, getUsage } from "../state.js";

export const agentRoutes = new Hono<{ Variables: Variables }>();

agentRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("agents.register"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = c.get("principalId")!;
    const principal = await ctx.repos.principals.getById(principalId);
    if (!principal) return c.json({ error: "not_found" }, 404);

    const parsed = RegisterAgentRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error.flatten() }, 400);
    }

    const decision = ctx.policy.evaluate(
      principal,
      {
        subject: { type: "principal", id: principal.id, assurance: principal.assurance },
        action: "agent.register_ephemeral",
        resource: { type: "agent", id: "*" },
      },
      getUsage(ctx.stores, principalId),
    );
    if (decision.effect === "deny") {
      return c.json({ error: "forbidden", reasons: decision.reasons }, 403);
    }

    const now = ctx.clock();
    const agentId = `agt_${randomUUID()}`;
    const instanceId = `agi_${randomUUID()}`;

    const agent: Agent = {
      id: agentId,
      ownerPrincipalId: principalId,
      displayName: parsed.data.displayName,
      state: "provisional",
      createdAt: now,
      ...(parsed.data.provider !== undefined ? { provider: parsed.data.provider } : {}),
      ...(parsed.data.softwareIdentity !== undefined
        ? { softwareIdentity: parsed.data.softwareIdentity }
        : {}),
    };
    const instance: AgentInstance = {
      id: instanceId,
      agentId,
      publicKeyJkt: parsed.data.publicKeyJkt,
      createdAt: now,
      ...(parsed.data.runtimeProvider !== undefined
        ? { runtimeProvider: parsed.data.runtimeProvider }
        : {}),
      ...(parsed.data.attestationDigest !== undefined
        ? { attestationDigest: parsed.data.attestationDigest }
        : {}),
    };
    ctx.stores.agents.set(agentId, agent);
    ctx.stores.agentInstances.set(instanceId, instance);

    const claim = await ctx.claims.createClaim({
      type: "agent",
      targetManifest: {
        agentId,
        instanceId,
        ownerPrincipalId: principalId,
        publicKeyJkt: parsed.data.publicKeyJkt,
      },
      creatorPrincipalId: principalId,
      creatorAgentId: agentId,
      creatorInstanceId: instanceId,
      proofKeyJkt: parsed.data.publicKeyJkt,
    });

    bumpUsage(ctx.stores, principalId, { agents: 1 });

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "agent.registered",
      outcome: "succeeded",
      principalId,
      claimId: claim.session.id,
      agentInstanceId: instanceId,
      correlationId: c.get("correlationId"),
      metadata: { action: "agent.register_ephemeral", state: "provisional" },
    });

    const body = RegisterAgentResponseSchema.parse({
      agentId,
      instanceId,
      state: "provisional",
      claimId: claim.session.id,
      claimToken: claim.token,
      userCode: claim.userCode,
      verificationUri: `${ctx.config.publicUrl}/v1/claims/${claim.session.id}/verify`,
      expiresAt: claim.session.expiresAt.toISOString(),
    });
    return c.json(body, 201);
  },
);

agentRoutes.post(
  "/:id/claim",
  requirePrincipal(),
  idempotencyMiddleware("agents.claim"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = c.get("principalId")!;
    const agentId = c.req.param("id");
    const agent = ctx.stores.agents.get(agentId);
    // A claim asserts `ownerPrincipalId` in its manifest and flips the agent to
    // `claimed` on completion, so an unfenced claim would let any caller take
    // over someone else's agent. Foreign ids answer 404, not 403: the id space
    // must not be enumerable either.
    if (!agent || agent.ownerPrincipalId !== principalId) {
      return c.json({ error: "not_found" }, 404);
    }

    const claim = await ctx.claims.createClaim({
      type: "agent",
      targetManifest: {
        agentId,
        ownerPrincipalId: principalId,
      },
      creatorPrincipalId: principalId,
      creatorAgentId: agentId,
    });

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "agent.claim_started",
      outcome: "succeeded",
      principalId,
      claimId: claim.session.id,
      correlationId: c.get("correlationId"),
      metadata: { action: "agent.claim", state: agent.state },
    });

    return c.json(
      {
        agentId,
        claimId: claim.session.id,
        claimToken: claim.token,
        userCode: claim.userCode,
        verificationUri: `${ctx.config.publicUrl}/v1/claims/${claim.session.id}/verify`,
        expiresAt: claim.session.expiresAt.toISOString(),
      },
      201,
    );
  },
);
