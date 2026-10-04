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

/**
 * A sign-in consent that is still being decided in the relying party's own
 * window. That window raised the request and holds the port its answer goes
 * to, so it is decided there, in the same breath; no list can offer it, no
 * tab can answer it, and nobody is waiting on it that the window is not
 * already asking. A list that showed it would invite a decision that makes the
 * window's own fail, and one that rang for it would announce a request to the
 * person who is looking at it.
 */
export function isSignInInFlight(
  row: Pick<LocalAccessRequestRecord, "authorizationDigest" | "status">,
): boolean {
  return Boolean(row.authorizationDigest) && row.status === "pending";
}
