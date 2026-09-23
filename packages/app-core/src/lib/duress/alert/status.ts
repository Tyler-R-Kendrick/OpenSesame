import { includesStringLiteral } from "../json-boundary.js";

/**
 * Alert delivery status vocabulary (INV-16).
 * queued ≠ delivered ≠ recipient_received ≠ human_acknowledged.
 */

export type AlertDeliveryStatus =
  | "queued"
  | "delivered"
  | "recipient_received"
  | "human_acknowledged"
  | "failed"
  | "expired"
  | "cancelled";

/** Forward-only happy-path order. Terminal statuses are separate. */
export const ALERT_STATUS_ORDER: readonly AlertDeliveryStatus[] = [
  "queued",
  "delivered",
  "recipient_received",
  "human_acknowledged",
] as const;

export const TERMINAL_ALERT_STATUSES: readonly AlertDeliveryStatus[] = [
  "failed",
  "expired",
  "cancelled",
  "human_acknowledged",
] as const;

export type AlertAdvanceAuthority =
  | "relay"
  | "recipient_device"
  | "human"
  | "local_policy";

export function authorityForStatus(
  status: AlertDeliveryStatus,
): AlertAdvanceAuthority | null {
  switch (status) {
    case "delivered":
      return "relay";
    case "recipient_received":
      return "recipient_device";
    case "human_acknowledged":
      return "human";
    case "failed":
    case "expired":
    case "cancelled":
      return "local_policy";
    default:
      return null;
  }
}

export function isTerminalStatus(status: AlertDeliveryStatus): boolean {
  return includesStringLiteral(TERMINAL_ALERT_STATUSES, status);
}
