/**
 * Live-session outcomes in the notifications tray (ADR 0163, ADR 0150).
 */

import { setStatusNotice } from "../notices.js";

const PREFIX = "sharing.live";
export const LIVE_SESSION_FAILURE_MARK = "Could not join";
export const LIVE_SESSION_ENDED_TRAY = "The session ended";
export const LIVE_VAULT_LOCKED_TRAY = "Ended because the vault locked";

/**
 * A live outcome is one more row in the tray. It is not an arrival: opening
 * the bell sheet would cover the control the person is already using.
 */
export function reportLiveOutcome(title: string, body: string): void {
  setStatusNotice({
    id: `${PREFIX}.${crypto.randomUUID()}`,
    tone: "err",
    title,
    body,
  });
}
