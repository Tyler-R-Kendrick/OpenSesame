import type {
  AgentAccessTokenRecord,
  AgentClaimAttempt,
  AgentRegistration,
  AgentServiceAssertionRecord,
} from "@opensesame/os-domain";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export function cloneRegistration(row: AgentRegistration): AgentRegistration {
  const next: AgentRegistration = {
    ...row,
    preClaimScopes: [...row.preClaimScopes],
    postClaimScopes: [...row.postClaimScopes],
  };
  if (row.claimTokenDigest) {
    next.claimTokenDigest = new Uint8Array(row.claimTokenDigest);
  }
  return next;
}

export function cloneAttempt(row: AgentClaimAttempt): AgentClaimAttempt {
  return {
    ...row,
    attemptTokenDigest: new Uint8Array(row.attemptTokenDigest),
    userCodeDigest: new Uint8Array(row.userCodeDigest),
  };
}

export function cloneAccess(
  row: AgentAccessTokenRecord,
): AgentAccessTokenRecord {
  return {
    ...row,
    scopes: [...row.scopes],
    tokenDigest: new Uint8Array(row.tokenDigest),
  };
}

export function cloneAssertion(
  row: AgentServiceAssertionRecord,
): AgentServiceAssertionRecord {
  return { ...row };
}

type Db = PostgresJsDatabase<typeof schema>;

export function mapAttempt(
  row: typeof schema.agentClaimAttempts.$inferSelect,
): AgentClaimAttempt {
  const mapped: AgentClaimAttempt = {
    id: row.id,
    registrationId: row.registrationId,
    attemptTokenDigest: row.attemptTokenDigest,
    userCodeDigest: row.userCodeDigest,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    intervalSeconds: row.intervalSeconds,
    pollCount: row.pollCount,
    failedAttempts: row.failedAttempts,
  };
  if (row.emailNormalized) mapped.emailNormalized = row.emailNormalized;
  if (row.slowdownUntil) mapped.slowdownUntil = row.slowdownUntil;
  if (row.completedAt) mapped.completedAt = row.completedAt;
  return mapped;
}

export function mapAccess(
  row: typeof schema.agentAccessTokens.$inferSelect,
): AgentAccessTokenRecord {
  const mapped: AgentAccessTokenRecord = {
    id: row.id,
    registrationId: row.registrationId,
    tokenDigest: row.tokenDigest,
    scopes: row.scopes,
    claimed: row.claimed,
    assertionVersion: row.assertionVersion,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
  if (row.resource) mapped.resource = row.resource;
  if (row.revokedAt) mapped.revokedAt = row.revokedAt;
  return mapped;
}

export function mapAssertion(
  row: typeof schema.agentServiceAssertions.$inferSelect,
): AgentServiceAssertionRecord {
  const mapped: AgentServiceAssertionRecord = {
    jti: row.jti,
    registrationId: row.registrationId,
    assertionVersion: row.assertionVersion,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
  if (row.revokedAt) mapped.revokedAt = row.revokedAt;
  return mapped;
}
