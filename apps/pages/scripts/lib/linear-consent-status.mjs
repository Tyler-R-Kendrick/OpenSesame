/** Fixed diagnostic codes only; no provider text or callback data leaves the page. */
export const LINEAR_STATUS_RULES = Object.freeze([
  ["Invalid provider authorization URL", "authorization-url-invalid"],
  ["Provider authorization request expired", "authorization-request-expired"],
  [
    "Provider authorization request exceeds allowed lifetime",
    "authorization-lifetime-excessive",
  ],
  ["lease aborted", "capability-lease-ended"],
  ["Provider authorization was cancelled or expired", "provider-wait-ended"],
  ["Finish the current Linear sign-in first", "sign-in-already-running"],
  ["Linear sign-in was cancelled", "original-reservation-ended"],
  ["Provider sign-in was cancelled", "ticket-ended"],
  ["Provider sign-in selection changed", "selection-changed"],
  ["This provider sign-in page ended", "page-owner-ended"],
  ["This provider sign-in selection ended", "selection-ended"],
  ["Finish the current provider sign-in first", "popup-already-reserved"],
  [
    "Reserve a fresh provider sign-in window first",
    "popup-reservation-missing",
  ],
  [
    "Invalid or expired provider authorization request",
    "request-expired-or-invalid",
  ],
  ["Provider authorization was cancelled", "provider-wait-cancelled"],
  ["This provider authorization window was already used", "popup-already-used"],
  ["Saved Linear connector not found", "saved-connector-missing"],
  ["Saved Linear configuration is invalid", "saved-configuration-invalid"],
  ["Linear configuration changed; restart consent", "configuration-changed"],
  ["Enter the registered Linear OAuth client ID first", "client-id-missing"],
  [
    "Linear OAuth requires durable browser storage; enable browser storage or use an API key",
    "durable-storage-unavailable",
  ],
  [
    "The original Linear workspace is required to recover this webhook",
    "recovery-workspace-missing",
  ],
  [
    "Reconnect the original Linear workspace to recover its webhook",
    "wrong-recovery-workspace",
  ],
  [
    "Linear authorization was not saved and provider cleanup failed. Reconnect or revoke this application in Linear Settings",
    "rejected-grant-cleanup-failed",
  ],
  [
    "Could not reach Linear. Check your connection and try again.",
    "provider-network-failure",
  ],
  [
    "Linear did not complete the requested operation.",
    "provider-response-failure",
  ],
]);

/** Also serializable as a Playwright evaluate callback; unknown labels are discarded. */
export function knownLinearStatusCodes(nodes, rules = LINEAR_STATUS_RULES) {
  const codes = new Set();
  for (const node of nodes) {
    const label = node.getAttribute("aria-label");
    for (const [sentence, code] of rules)
      if (label === sentence) codes.add(code);
  }
  return [...codes].sort();
}

export async function readLinearStatusCodes(page) {
  return page
    .locator(".status-mark[role=img]")
    .evaluateAll(knownLinearStatusCodes, LINEAR_STATUS_RULES);
}
