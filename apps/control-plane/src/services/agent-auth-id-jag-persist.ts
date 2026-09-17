import {
  type VerifiedProviderIdentity,
  agentAuthError,
} from "@opensesame/agent-protocols";
import { appendAuditEvent } from "@opensesame/audit";
import { ConflictError } from "@opensesame/database";
import type {
  AgentRegistration,
  ExternalIdentity,
  Principal,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { consumeProviderReplay } from "./agent-auth-id-jag-trust.js";
import { effectiveScopes, mintAssertion } from "./agent-auth-shared.js";

export async function commitProviderRegistration(
  ctx: AppContext,
  args: {
    identity: VerifiedProviderIdentity;
    principal: Principal;
    registration: AgentRegistration;
    existing: ExternalIdentity | null;
    identityRow: ExternalIdentity | null;
    now: Date;
    correlationId: string;
  },
): Promise<Record<string, unknown>> {
  const {
    identity,
    principal,
    registration,
    existing,
    identityRow,
    now,
    correlationId,
  } = args;
  try {
    await ctx.repos.transaction(async (uow) => {
      const won = await consumeProviderReplay(
        ctx,
        identity.issuer,
        identity.assertionId,
        identity.expiresAt,
        uow,
      );
      if (!won) {
        throw agentAuthError("invalid_request", 400, "assertion replayed");
      }
      if (!existing) {
        await ctx.repos.principals.create(principal, uow);
        if (identityRow) {
          await ctx.repos.externalIdentities.create(identityRow, uow);
        }
      }
      await ctx.repos.agentAuth.createRegistration(registration, uow);
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw agentAuthError("invalid_request", 400, "registration conflict");
    }
    throw error;
  }

  const scopes = effectiveScopes(ctx, registration, principal);
  const assertion = await mintAssertion(ctx, registration, true, scopes, now);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "agent_auth.registration.created",
    outcome: "succeeded",
    principalId: principal.id,
    correlationId,
    actorType: "agent",
    targetType: "agent_registration",
    targetId: registration.id,
    metadata: {
      type: "identity_assertion",
      action: "agent_auth.register",
      issuer: identity.issuer,
    },
  });

  return {
    registration_id: registration.id,
    registration_type: "identity_assertion",
    identity_assertion: assertion.jwt,
    assertion_expires: assertion.expiresAt.toISOString(),
    scopes,
  };
}
