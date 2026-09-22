/**
 * ALERT-E: Late-delivery / cancel / compromise / failure policies.
 * Never change visible presentation profile or escalate to destruction (INV-17).
 */

import type { AlertDeliveryStatus, LateDeliveryPolicy } from "./outbox.js";

export type AlertFailureKind =
  | "transport_rejected"
  | "transport_error"
  | "route_revoked"
  | "route_expired"
  | "evidence_invalid"
  | "compromised_device"
  | "clock_skew_expired";

export type AlertPolicyDecision = Readonly<{
  nextStatus: AlertDeliveryStatus | "retry";
  /** Explicit: failure never mutates presentation or triggers removal. */
  presentationUnchanged: true;
  destructionEscalation: false;
  kind: AlertFailureKind | "late_delivery" | "ok";
}>;

export function decideLateDelivery(
  policy: LateDeliveryPolicy,
  incidentResolved: boolean,
): AlertPolicyDecision {
  if (!incidentResolved) {
    return {
      nextStatus: "retry",
      presentationUnchanged: true,
      destructionEscalation: false,
      kind: "ok",
    };
  }
  switch (policy.kind) {
    case "cancel_if_resolved":
      return {
        nextStatus: "cancelled",
        presentationUnchanged: true,
        destructionEscalation: false,
        kind: "late_delivery",
      };
    case "mark_expired":
      return {
        nextStatus: "expired",
        presentationUnchanged: true,
        destructionEscalation: false,
        kind: "late_delivery",
      };
    case "deliver_anyway":
      return {
        nextStatus: "retry",
        presentationUnchanged: true,
        destructionEscalation: false,
        kind: "late_delivery",
      };
  }
}

export function decideTransportFailure(input: {
  kind: AlertFailureKind;
  attempts: number;
  maxRetries: number;
}): AlertPolicyDecision {
  if (
    input.kind === "compromised_device" ||
    input.kind === "evidence_invalid"
  ) {
    return {
      nextStatus: "failed",
      presentationUnchanged: true,
      destructionEscalation: false,
      kind: input.kind,
    };
  }
  if (input.kind === "route_revoked" || input.kind === "route_expired") {
    return {
      nextStatus: "failed",
      presentationUnchanged: true,
      destructionEscalation: false,
      kind: input.kind,
    };
  }
  if (input.kind === "clock_skew_expired") {
    return {
      nextStatus: "expired",
      presentationUnchanged: true,
      destructionEscalation: false,
      kind: input.kind,
    };
  }
  if (input.attempts > input.maxRetries) {
    return {
      nextStatus: "failed",
      presentationUnchanged: true,
      destructionEscalation: false,
      kind: input.kind,
    };
  }
  return {
    nextStatus: "retry",
    presentationUnchanged: true,
    destructionEscalation: false,
    kind: input.kind,
  };
}
