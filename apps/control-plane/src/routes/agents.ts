import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  RegisterAgentRequestSchema,
  RegisterAgentResponseSchema,
} from "@opensesame/contracts";
import type { Agent, AgentInstance } from "@opensesame/os-domain";
import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { getUsage } from "../state.js";
import { authenticatedPrincipalId } from "./organizations.js";
import { resolveActiveProject, roleFor } from "./projects.js";

export const agentRoutes = new Hono<{ Variables: Variables }>();

agentRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("agents.register"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const principal = await ctx.repos.principals.getById(principalId);
    if (!principal) return c.json({ error: "not_found" }, 404);

    const parsed = RegisterAgentRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    const decision = ctx.policy.evaluate(
      principal,
      {
        subject: {
          type: "principal",
          id: principal.id,
          assurance: principal.assurance,
        },
        action: "agent.register_ephemeral",
        resource: { type: "agent", id: "*" },
      },
      await getUsage(ctx.stores, principalId, ctx.clock()),
    );
    if (decision.effect === "deny") {
      return c.json({ error: "forbidden", reasons: decision.reasons }, 403);
    }

    // Agents always belong to a project: the requested one when the caller
    // may use it, otherwise the caller's active (default: personal) project.
    let projectId: string;
    if (parsed.data.projectId) {
      const project = ctx.stores.projects.get(parsed.data.projectId);
      if (!project || !roleFor(ctx, project, principalId)) {
        return c.json({ error: "project_not_found" }, 404);
      }
      projectId = project.id;
    } else {
      projectId = resolveActiveProject(ctx, principalId).id;
    }

    const now = ctx.clock();
    const agentId = `agt_${randomUUID()}`;
    const instanceId = `agi_${randomUUID()}`;

    const agent: Agent = {
      id: agentId,
      projectId,
      ownerPrincipalId: principalId,
      displayName: parsed.data.displayName,
      state: "provisional",
      createdAt: now,
      ...(parsed.data.provider !== undefined
        ? { provider: parsed.data.provider }
        : undefined),
      ...(parsed.data.softwareIdentity !== undefined
        ? { softwareIdentity: parsed.data.softwareIdentity }
        : undefined),
    };
    const instance: AgentInstance = {
      id: instanceId,
      agentId,
      publicKeyJkt: parsed.data.publicKeyJkt,
      createdAt: now,
      ...(parsed.data.runtimeProvider !== undefined
        ? { runtimeProvider: parsed.data.runtimeProvider }
        : undefined),
      ...(parsed.data.attestationDigest !== undefined
        ? { attestationDigest: parsed.data.attestationDigest }
        : undefined),
    };
    ctx.stores.agents.set(agentId, agent);
    ctx.stores.agentInstances.set(instanceId, instance);

    let claim: Awaited<ReturnType<typeof ctx.claims.createClaim>>;
    try {
      claim = await ctx.claims.createClaim({
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
    } catch (error) {
      ctx.stores.agents.delete(agentId);
      ctx.stores.agentInstances.delete(instanceId);
      throw error;
    }

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
      projectId,
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
    const principalId = authenticatedPrincipalId(c.get("principalId"));
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
