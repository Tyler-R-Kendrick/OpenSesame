/**
 * GA-I-01 — Identity authority enrollment and workload spawn.
 */

import { appendAuditEvent } from "@opensesame/audit";
import {
  AUTHORITY_PRINCIPAL_KINDS,
  DomainError,
  bindProofOfPossession,
  spawnWorkloadIdentity,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";

export const authorityRoutes = new Hono<{ Variables: Variables }>();

type AppContext = Context<{ Variables: Variables }>;

const OrchestratorKind = z.enum([
  "agent_registration",
  "actor_instance",
  "service",
]);

const SpawnBody = z
  .object({
    orchestratorKind: OrchestratorKind,
    orchestratorPrincipalId: z.string().trim().min(1).max(256),
    realmId: z.string().trim().min(1).max(256),
    taskId: z.string().trim().min(1).max(256),
    accessDomainId: z.string().trim().min(1).max(256),
    runtimeProfile: z.string().trim().min(1).max(64),
    authorityGeneration: z.number().int().min(1),
    publicKeyJkt: z.string().trim().min(8).max(256),
    ordinal: z.number().int().min(0).optional(),
    restoredFromGeneration: z.number().int().min(0).optional(),
  })
  .strict();

const EnrollPopBody = z
  .object({
    subjectKind: z.enum(["actor_instance", "device", "workload_instance"]),
    principalId: z.string().trim().min(1).max(256),
    publicKeyJkt: z.string().trim().min(8).max(256),
    authorityGeneration: z.number().int().min(1),
    expiresAt: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

function invariantResponse(c: AppContext, error: DomainError) {
  return c.json(
    {
      error: "invariant_violation",
      code: error.code,
      message: error.message,
      details: error.details,
    },
    400,
  );
}

async function spawnWorkload(c: AppContext) {
  const ctx = c.get("ctx");
  const principal = authenticatedPrincipalId(c.get("principalId"));
  const parsed = SpawnBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      {
        error: "validation_error",
        issueCount: parsed.error.issues.length,
      },
      400,
    );
  }
  const body = parsed.data;
  try {
    const orchestrator = {
      kind: body.orchestratorKind,
      principalId: body.orchestratorPrincipalId,
      realmId: body.realmId,
    };
    const ordinal = body.ordinal ?? 0;
    const spawned =
      body.restoredFromGeneration === undefined
        ? spawnWorkloadIdentity({
            orchestrator,
            taskId: body.taskId,
            accessDomainId: body.accessDomainId,
            runtimeProfile: body.runtimeProfile,
            authorityGeneration: body.authorityGeneration,
            publicKeyJkt: body.publicKeyJkt,
            ordinal,
            boundAt: ctx.clock(),
          })
        : spawnWorkloadIdentity({
            orchestrator,
            taskId: body.taskId,
            accessDomainId: body.accessDomainId,
            runtimeProfile: body.runtimeProfile,
            authorityGeneration: body.authorityGeneration,
            publicKeyJkt: body.publicKeyJkt,
            ordinal,
            boundAt: ctx.clock(),
            restoredFromGeneration: body.restoredFromGeneration,
          });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authority.workload.spawned",
      outcome: "succeeded",
      principalId: principal,
      correlationId: c.get("correlationId"),
      targetType: "workload_instance",
      targetId: spawned.principalId,
      metadata: {
        action: "authority.workload.spawn",
        runtimeProfile: spawned.binding.runtimeProfile,
        taskId: spawned.binding.taskId,
        accessDomainId: spawned.binding.accessDomainId,
        authorityGeneration: spawned.binding.authorityGeneration,
      },
    });
    return c.json(
      {
        kind: spawned.kind,
        principalId: spawned.principalId,
        actorInstanceId: spawned.actorInstanceId,
        publicKeyJkt: spawned.publicKeyJkt,
        binding: {
          orchestrator: {
            kind: spawned.binding.orchestrator.kind,
            principalId: spawned.binding.orchestrator.principalId,
            realmId: spawned.binding.orchestrator.realmId,
          },
          taskId: spawned.binding.taskId,
          accessDomainId: spawned.binding.accessDomainId,
          runtimeProfile: spawned.binding.runtimeProfile,
          authorityGeneration: spawned.binding.authorityGeneration,
        },
      },
      201,
    );
  } catch (error) {
    if (error instanceof DomainError) return invariantResponse(c, error);
    throw error;
  }
}

async function enrollPop(c: AppContext) {
  const ctx = c.get("ctx");
  const principal = authenticatedPrincipalId(c.get("principalId"));
  const parsed = EnrollPopBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      {
        error: "validation_error",
        issueCount: parsed.error.issues.length,
      },
      400,
    );
  }
  const body = parsed.data;
  try {
    const boundAt = ctx.clock();
    const enrollment =
      body.expiresAt === undefined
        ? bindProofOfPossession({
            subjectKind: body.subjectKind,
            principalId: body.principalId,
            publicKeyJkt: body.publicKeyJkt,
            authorityGeneration: body.authorityGeneration,
            boundAt,
          })
        : bindProofOfPossession({
            subjectKind: body.subjectKind,
            principalId: body.principalId,
            publicKeyJkt: body.publicKeyJkt,
            authorityGeneration: body.authorityGeneration,
            boundAt,
            expiresAt: new Date(body.expiresAt),
          });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authority.enrollment.pop",
      outcome: "succeeded",
      principalId: principal,
      correlationId: c.get("correlationId"),
      targetType: body.subjectKind,
      targetId: body.principalId,
      metadata: {
        action: "authority.enrollment.pop",
        authorityGeneration: enrollment.authorityGeneration,
        subjectKind: enrollment.subjectKind,
      },
    });
    if (enrollment.expiresAt === undefined) {
      return c.json(
        {
          subjectKind: enrollment.subjectKind,
          principalId: enrollment.principalId,
          publicKeyJkt: enrollment.publicKeyJkt,
          authorityGeneration: enrollment.authorityGeneration,
          boundAt: enrollment.boundAt.toISOString(),
        },
        201,
      );
    }
    return c.json(
      {
        subjectKind: enrollment.subjectKind,
        principalId: enrollment.principalId,
        publicKeyJkt: enrollment.publicKeyJkt,
        authorityGeneration: enrollment.authorityGeneration,
        boundAt: enrollment.boundAt.toISOString(),
        expiresAt: enrollment.expiresAt.toISOString(),
      },
      201,
    );
  } catch (error) {
    if (error instanceof DomainError) return invariantResponse(c, error);
    throw error;
  }
}

authorityRoutes.post("/workloads/spawn", requirePrincipal(), spawnWorkload);
authorityRoutes.post("/enrollment/pop", requirePrincipal(), enrollPop);
authorityRoutes.get("/principal-kinds", requirePrincipal(), (c) =>
  c.json({ kinds: AUTHORITY_PRINCIPAL_KINDS }),
);
