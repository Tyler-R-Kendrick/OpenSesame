/**
 * Whether a person took a standing connector grant away (ADR 0015 trail).
 *
 * Standing connector grants are re-issued whenever the vault's default access
 * is ensured. A revocation on Access must outlast that: the sealed trail
 * records `access.connection.revoked` with the revoked principal as
 * `subject`, and the newest grant-or-revoke event for this connector and
 * principal decides. An event recorded before `subject` was kept names no
 * principal, so it counts for every principal of that connector — an old
 * revocation keeps all of them revoked.
 */

import { isString } from "@opensesame/os-domain";
import type { LocalAccessAuditEvent } from "./local-access-audit.js";

function subjectOf(event: LocalAccessAuditEvent): string | null {
  const subject = event.metadata.subject;
  return isString(subject) ? subject : null;
}

/** `events` is the trail as `listAccessAuditEvents` returns it: newest first. */
export function standingConnectionRevoked(
  events: readonly LocalAccessAuditEvent[],
  resourceId: string,
  principalId: string,
): boolean {
  const last = events.find((event) => {
    if (event.targetType !== "connection" || event.targetId !== resourceId)
      return false;
    if (
      event.eventType !== "access.connection.granted" &&
      event.eventType !== "access.connection.revoked"
    )
      return false;
    const subject = subjectOf(event);
    return subject === null || subject === principalId;
  });
  return last?.eventType === "access.connection.revoked";
}
