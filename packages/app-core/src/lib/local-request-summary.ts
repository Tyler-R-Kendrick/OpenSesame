import type { LocalAccessRequestRecord } from "@opensesame/contracts";

/**
 * A request as the custodian sees it. Identifiers are references, not
 * credentials or private presentations: the approval's credential and public
 * key stay in the sealed record and only the approving principal is named.
 */
export function summarize(row: LocalAccessRequestRecord) {
  return {
    id: row.id,
    version: row.version,
    requestDigest: row.requestDigest,
    requesterId: row.requesterId,
    applicationId: row.applicationId,
    applicationRevision: row.applicationRevision,
    authorizationDigest: row.authorizationDigest,
    organizationId: row.organizationId,
    redirectUri: row.redirectUri,
    scopes: [...row.scopes],
    reason: row.reason,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status,
    decidedAt: row.decidedAt,
    approvingPrincipalId: row.approval?.principalId ?? null,
  };
}
export type LocalAccessRequest = ReturnType<typeof summarize>;
