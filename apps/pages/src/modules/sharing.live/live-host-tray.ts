/**
 * Tray sentences for the owner's live session (ADR 0163).
 */

import type { HostState } from "@opensesame/app-core/lib/live/host.js";
import { reportLiveOutcome } from "@opensesame/app-core/lib/live/outcome-notices.js";

const seenAsking = new Set<string>();

/** Forget guests already announced (tests). */
export function resetLiveHostTrayForTests(): void {
  seenAsking.clear();
}

/** Bell/tray when someone new is asking to join. */
export function noteGuestAsking(state: HostState): void {
  for (const guest of state.guests) {
    if (guest.state !== "asking" || seenAsking.has(guest.key)) continue;
    seenAsking.add(guest.key);
    reportLiveOutcome("Live session", `${guest.name} is asking to join`);
  }
}
