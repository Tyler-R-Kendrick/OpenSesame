/**
 * Consume drain: reservation, subject settlement, Identity-plane apply (ADR 0125).
 */

import { randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import type { NewOutboxEvent, UnitOfWork } from "@opensesame/database";
import {
  DomainError,
  type Interaction,
  type InteractionKind,
  interactionMachine,
} from "@opensesame/os-domain";
import { mechanismPermittedForKind } from "@opensesame/policy";
import type { AppContext } from "../context.js";
import { settleInteractionSubject } from "../routes/subject-adapters.js";
import { applyHostCeremonySubject } from "./ceremony-subject-apply.js";
import { resolveEntitledSubject } from "./ceremony-subject-resolve.js";
import {
  dispatchHostSettlementHttp,
  hostSettlementDispatchEnabled,
} from "./host-settlement-http.js";
import {
  type HostEffect,
  type HostSettlementOutcome,
  type SettledSubjectFacts,
  settleHostSubject,
} from "./host-settlement.js";

export { resolveEntitledSubject };

const RESERVATION_LEASE_MS = 60_000;

async function applyIdentitySubject(
  ctx: AppContext,
  interaction: Interaction,
  now: Date,
  uow: UnitOfWork,
): Promise<SettledSubjectFacts> {
  const subjectId = interaction.subject.subjectId;
  if (interaction.kind === "authorization_request") {
    const request = await ctx.repos.authorizationRequests.getById(subjectId);
    if (!request || request.status !== "pending") return {};
    await ctx.repos.authorizationRequests.updateWithVersion(
      request.id,
      request.version,
      {
        status: "approved",
        decidedAt: now,
        decidedByKind: "human",
        ...(interaction.approverPrincipalId
          ? { decidedByPrincipalId: interaction.approverPrincipalId }
          : undefined),
      },
      uow,
    );
    return { authzApproved: true };
  }
  if (interaction.kind !== "claim" && interaction.kind !== "grant_claim") {
    return {};
  }
  const session = await ctx.repos.claimSessions.getById(subjectId);
  if (
    !session ||
    session.state === "completed" ||
    session.state === "denied" ||
    session.state === "revoked" ||
    session.state === "expired"
  ) {
    return {};
  }
  await ctx.repos.claimSessions.updateWithVersion(
    session.id,
    session.version,
    {
      state: "completed",
      completedAt: now,
      ...(interaction.approverPrincipalId
        ? { completedByPrincipalId: interaction.approverPrincipalId }
        : undefined),
    },
    uow,
  );
  return { claimCompleted: true, claimId: session.id };
}

export interface ConsumeSettlement {
  readonly interaction: Interaction;
  readonly command: NewOutboxEvent;
  readonly hostEffect: HostEffect;
}

export function actorTypeFromProof(
  proof: Interaction["approvalProof"],
): "human" | "system" {
  const mechanism = proof?.mechanism;
  if (
    mechanism === "webauthn" ||
    mechanism === "openid4vp" ||
    mechanism === "out_of_band"
  ) {
    return "human";
  }
  return "system";
}

export async function consumeAndSettle(
  ctx: AppContext,
  row: Interaction,
  now: Date,
  uow: UnitOfWork,
): Promise<ConsumeSettlement> {
  const proof = row.approvalProof;
  if (
    proof &&
    mechanismPermittedForKind(proof.mechanism, row.kind).effect === "refused"
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "legacy proof cannot execute this kind",
    );
  }
  const spent = interactionMachine.consume(row, now);
  const updated = await ctx.repos.interactions.updateWithVersion(
    row.id,
    row.version,
    { status: spent.status, consumedAt: now },
    uow,
  );
  const reservation = await ctx.repos.executionReservations.acquire(
    {
      id: `xrsv_${randomBytes(12).toString("base64url")}`,
      interactionId: updated.id,
      requestDigest: updated.requestDigest ?? `none:${updated.id}`,
      holderRef: "consume",
      leaseExpiresAt: new Date(now.getTime() + RESERVATION_LEASE_MS),
    },
    uow,
  );
  const settlement = await settleInteractionSubject(ctx, updated, uow);
  if (!settlement.ok) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      `subject binding refused at dispatch: ${settlement.reason}`,
    );
  }
  const identityFacts = await applyIdentitySubject(ctx, updated, now, uow);
  await ctx.repos.executionReservations.commit(
    reservation.id,
    reservation.fencingToken,
    now,
    uow,
  );
  // After the fence: a losing consume must not throw on the ceremony row and
  // leave a higher held token that then fences the winner (T-07).
  applyHostCeremonySubject(ctx, updated, now);
  const hostEffect = settleHostSubject(
    ctx.stores.hostSettlement,
    ctx.stores.ceremonySubjects,
    updated,
    settlement.command.eventType,
    identityFacts,
  );
  return {
    interaction: updated,
    command: settlement.command,
    hostEffect,
  };
}

export async function drainConsumedSettlement(
  ctx: AppContext,
  saved: ConsumeSettlement,
  correlationId?: string,
): Promise<HostSettlementOutcome> {
  const outcome = saved.hostEffect.outcome;
  // Host is optional. A missing or unreachable Host must not un-succeed
  // Identity ceremony settlement or invite a second consume.
  if (hostSettlementDispatchEnabled(ctx.config)) {
    await dispatchHostSettlementHttp(ctx.config, {
      eventType: saved.command.eventType,
      interactionId: saved.interaction.id,
      ...(saved.interaction.requestDigest
        ? { requestDigest: saved.interaction.requestDigest }
        : {}),
    });
  }
  const metadata: {
    interactionId: string;
    subjectKind: InteractionKind;
    eventType: string;
    execution: HostSettlementOutcome;
    requestDigest?: string;
  } = {
    interactionId: saved.interaction.id,
    subjectKind: saved.interaction.subject.kind,
    eventType: saved.command.eventType,
    execution: outcome,
  };
  if (saved.interaction.requestDigest) {
    metadata.requestDigest = saved.interaction.requestDigest;
  }
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "interaction_subject.applied",
    ...(saved.interaction.approverPrincipalId
      ? { principalId: saved.interaction.approverPrincipalId }
      : undefined),
    actorType: actorTypeFromProof(saved.interaction.approvalProof),
    outcome: "succeeded",
    ...(correlationId ? { correlationId } : undefined),
    targetType: "interaction",
    targetId: saved.interaction.id,
    metadata,
  });
  return outcome;
}
