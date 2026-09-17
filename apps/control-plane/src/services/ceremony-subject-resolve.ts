/**
 * Entitlement for interaction create: existing Identity rows, or caller-owned
 * device/pairing/transaction ceremony records (ADR 0125, F04, T-09).
 */

import type { InteractionKind } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { requesterRef } from "../routes/interaction-handles.js";

function stillLive(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() > now.getTime();
}

async function resolveAuthorizationRequest(
  ctx: AppContext,
  subjectId: string,
  callerId: string,
): Promise<boolean> {
  const request = await ctx.repos.authorizationRequests.getById(subjectId);
  if (!request || request.status !== "pending") return false;
  if (!stillLive(request.expiresAt, ctx.clock())) return false;
  const callerHandle = requesterRef(callerId, ctx.config.claimPepper);
  return (
    request.requesterRef === callerHandle || request.principalId === callerId
  );
}

async function resolveClaim(
  ctx: AppContext,
  subjectId: string,
  callerId: string,
): Promise<boolean> {
  const session = await ctx.repos.claimSessions.getById(subjectId);
  if (!session || session.creatorPrincipalId !== callerId) return false;
  if (
    session.state === "completed" ||
    session.state === "denied" ||
    session.state === "revoked" ||
    session.state === "expired"
  ) {
    return false;
  }
  return stillLive(session.expiresAt, ctx.clock());
}

function resolveDevice(
  ctx: AppContext,
  subjectId: string,
  callerId: string,
): boolean {
  const existing = ctx.stores.ceremonySubjects.getDevice(subjectId);
  if (!existing || existing.ownerPrincipalId !== callerId) return false;
  if (existing.session.state === "consumed") return false;
  return stillLive(existing.session.expiresAt, ctx.clock());
}

function resolvePairing(
  ctx: AppContext,
  subjectId: string,
  callerId: string,
): boolean {
  const existing = ctx.stores.ceremonySubjects.getPairing(subjectId);
  if (!existing || existing.ownerPrincipalId !== callerId) return false;
  if (existing.state !== "pending") return false;
  return stillLive(existing.expiresAt, ctx.clock());
}

function resolveTransaction(
  ctx: AppContext,
  subjectId: string,
  callerId: string,
): boolean {
  const existing = ctx.stores.ceremonySubjects.getTransaction(subjectId);
  if (!existing || existing.ownerPrincipalId !== callerId) return false;
  if (existing.state !== "pending") return false;
  return stillLive(existing.expiresAt, ctx.clock());
}

const RESOLVERS: Record<
  InteractionKind,
  (ctx: AppContext, subjectId: string, callerId: string) => Promise<boolean>
> = {
  authorization_request: resolveAuthorizationRequest,
  claim: resolveClaim,
  grant_claim: resolveClaim,
  device_authorization: async (ctx, subjectId, callerId) =>
    resolveDevice(ctx, subjectId, callerId),
  pairing: async (ctx, subjectId, callerId) =>
    resolvePairing(ctx, subjectId, callerId),
  transaction_authorization: async (ctx, subjectId, callerId) =>
    resolveTransaction(ctx, subjectId, callerId),
};

export async function resolveEntitledSubject(
  ctx: AppContext,
  kind: InteractionKind,
  subjectId: string,
  callerId: string,
): Promise<boolean> {
  return RESOLVERS[kind](ctx, subjectId, callerId);
}
