/** The sealed Access trail entry for a connector share granted or revoked. */
import { recordAccessAuditEvent } from "./local-access-audit.js";

export async function recordConnectionShareEvent(
  tomb: string,
  eventType: "access.connection.granted" | "access.connection.revoked",
  share: { resourceId: string; principalId: string; policy: string },
): Promise<void> {
  await recordAccessAuditEvent(tomb, {
    eventType,
    outcome: "succeeded",
    targetType: "connection",
    targetId: share.resourceId,
    metadata: {
      providerId: share.resourceId,
      resourceType: "connection",
      resourceId: share.resourceId,
      // Whose grant, under which policy — a standing grant a person took
      // away is not re-issued for that principal and policy.
      subject: share.principalId,
      policy: share.policy,
      action: eventType === "access.connection.granted" ? "grant" : "revoke",
      kind: "share",
    },
  });
}
