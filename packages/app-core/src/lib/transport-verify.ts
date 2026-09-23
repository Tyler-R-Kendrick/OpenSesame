/**
 * `transport.verify.run` on the PWA surface: ask the endpoint to run its own
 * positive/negative probe (a harmless `GET /health/live` with and without a
 * certificate, CONTRACT §6), then read the status it recorded. The browser
 * proves nothing itself — it only asks, and only when a person presses the
 * key; a page cannot self-certify enforcement.
 */
import {
  TRANSPORT_VERIFY_PATH,
  type TransportStatusResult,
  readTransportStatus,
  settleTransportRequest,
} from "./transport-status.js";

export async function runTransportVerify(): Promise<TransportStatusResult> {
  const outcome = await settleTransportRequest(TRANSPORT_VERIFY_PATH, "POST");
  if (outcome.kind !== "accepted") return outcome;
  return readTransportStatus();
}
