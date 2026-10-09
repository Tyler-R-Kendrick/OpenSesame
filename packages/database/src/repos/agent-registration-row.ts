import type { AgentRegistration } from "@opensesame/os-domain";
import type * as schema from "../schema/index.js";

export function mapRegistration(
  row: typeof schema.agentRegistrations.$inferSelect,
): AgentRegistration {
  const mapped: AgentRegistration = {
    id: row.id,
    // SAFETY: stored kind is validated by migration 0022's CHECK against the domain union.
    kind: row.kind as AgentRegistration["kind"],
    // SAFETY: stored status is validated by migration 0022's CHECK against the domain union.
    status: row.status as AgentRegistration["status"],
    principalId: row.principalId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    preClaimScopes: row.preClaimScopes,
    postClaimScopes: row.postClaimScopes,
    assertionVersion: row.assertionVersion,
    version: row.version,
  };
  if (row.claimedByPrincipalId)
    mapped.claimedByPrincipalId = row.claimedByPrincipalId;
  if (row.claimedAt) mapped.claimedAt = row.claimedAt;
  if (row.revokedAt) mapped.revokedAt = row.revokedAt;
  if (row.resource) mapped.resource = row.resource;
  if (row.audience) mapped.audience = row.audience;
  if (row.claimEmailNormalized)
    mapped.claimEmailNormalized = row.claimEmailNormalized;
  if (row.claimTokenDigest) mapped.claimTokenDigest = row.claimTokenDigest;
  if (row.providerIssuer) mapped.providerIssuer = row.providerIssuer;
  if (row.providerSubject) mapped.providerSubject = row.providerSubject;
  if (row.providerClientId) mapped.providerClientId = row.providerClientId;
  return mapped;
}
