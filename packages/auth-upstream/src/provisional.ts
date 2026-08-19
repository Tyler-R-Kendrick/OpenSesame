import { randomBytes, randomUUID } from "node:crypto";
import type { PrincipalMapping, PrincipalMappingStore } from "./mapping.js";

export interface ProvisionalSession {
  id: string;
  principalId: string;
  betterAuthUserId: string;
  quotaProfile: string;
  allowedActions: string[];
  createdAt: Date;
  expiresAt: Date;
  claimedAt?: Date;
  revokedAt?: Date;
}

export interface CreateProvisionalOptions {
  ttlMs?: number;
  quotaProfile?: string;
  allowedActions?: string[];
}

/**
 * Create an anonymous / provisional principal + session mapping.
 * Upgrade paths must preserve `principalId`.
 */
export async function createProvisionalPrincipal(
  store: PrincipalMappingStore,
  options: CreateProvisionalOptions = {},
): Promise<{ mapping: PrincipalMapping; session: ProvisionalSession }> {
  const principalId = `prn_${randomUUID()}`;
  const betterAuthUserId = `ba_anon_${randomUUID()}`;
  const now = new Date();
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;

  const mapping: PrincipalMapping = {
    principalId,
    betterAuthUserId,
    provisional: true,
    createdAt: now,
  };
  await store.save(mapping);

  const session: ProvisionalSession = {
    id: `ps_${randomBytes(16).toString("hex")}`,
    principalId,
    betterAuthUserId,
    quotaProfile: options.quotaProfile ?? "anonymous",
    allowedActions: options.allowedActions ?? ["claim.create", "browse"],
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };

  return { mapping, session };
}

export interface UpgradeToUpstreamInput {
  principalId: string;
  betterAuthUserId: string;
  upstreamProviderId: string;
  upstreamSubject: string;
  email?: string;
}

/**
 * Upgrade a provisional principal to a linked upstream identity.
 * Preserves principalId. Does NOT auto-link by email to another principal.
 */
export async function upgradeProvisionalToUpstream(
  store: PrincipalMappingStore,
  input: UpgradeToUpstreamInput,
): Promise<PrincipalMapping> {
  const existing = await store.findByPrincipalId(input.principalId);
  if (!existing) {
    throw new Error(`Unknown principal: ${input.principalId}`);
  }

  const byUpstream = await store.findByUpstream(
    input.upstreamProviderId,
    input.upstreamSubject,
  );
  if (byUpstream && byUpstream.principalId !== input.principalId) {
    throw new Error(
      "Upstream identity already linked to a different principal",
    );
  }

  // Explicitly do NOT merge with findByEmail — email auto-link is forbidden.
  const upgraded: PrincipalMapping = {
    ...existing,
    betterAuthUserId: input.betterAuthUserId,
    upstreamProviderId: input.upstreamProviderId,
    upstreamSubject: input.upstreamSubject,
    ...(input.email !== undefined ? { email: input.email } : {}),
    provisional: false,
    upgradedAt: new Date(),
  };
  return store.save(upgraded);
}
