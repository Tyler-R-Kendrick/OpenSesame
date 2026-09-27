/**
 * Whether a person took a standing connector grant away (ADR 0015 trail).
 *
 * Standing connector grants are re-issued whenever the vault's default access
 * is ensured. A revocation on Access must outlast that: the sealed trail
 * records `access.connection.revoked` with the revoked grant's principal
 * (`subject`) and `policy`, and a person's grant records
 * `access.connection.granted` the same way. The newest of those for this
 * connector, principal and policy decides. An event that names no principal
 * was written before `subject` was kept and cannot say whose grant it was, so
 * it is ignored — which is how those events were read when they were written.
 * An event that names a principal but no policy counts for every policy.
 */

import { isString } from "@opensesame/os-domain";
import type { LocalAccessAuditEvent } from "./local-access-audit.js";

function field(event: LocalAccessAuditEvent, key: string): string | null {
  const value = event.metadata[key];
  return isString(value) ? value : null;
}

/** `events` is the trail as `listAccessAuditEvents` returns it: newest first. */
export function standingConnectionRevoked(
  events: readonly LocalAccessAuditEvent[],
  grant: { resourceId: string; principalId: string; policy: string },
): boolean {
  const last = events.find((event) => {
    if (
      event.targetType !== "connection" ||
      event.targetId !== grant.resourceId
    )
      return false;
    if (
      event.eventType !== "access.connection.granted" &&
      event.eventType !== "access.connection.revoked"
    )
      return false;
    if (field(event, "subject") !== grant.principalId) return false;
    const policy = field(event, "policy");
    return policy === null || policy === grant.policy;
  });
  return last?.eventType === "access.connection.revoked";
}
