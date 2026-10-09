/**
 * Tray sentences for the owner's live session (ADR 0163).
 */

import type { HostState } from "@opensesame/app-core/lib/live/host.js";
import { dismissNotice, setStatusNotice } from "@opensesame/app-core/lib/notices.js";

const seenAsking = new Set<string>();
const askingNotice = new Map<string, string>();

/** Forget guests already announced (tests). */
export function resetLiveHostTrayForTests(): void {
  seenAsking.clear();
  askingNotice.clear();
}

/** Drop tray rows for guests who were only asking, when the session ends. */
export function clearLiveHostAskingNotices(): void {
  for (const id of askingNotice.values()) dismissNotice(id);
  askingNotice.clear();
  seenAsking.clear();
}

/** Bell/tray when someone new is asking to join. */
export function noteGuestAsking(state: HostState): void {
  for (const guest of state.guests) {
    if (guest.state !== "asking" || seenAsking.has(guest.key)) continue;
    seenAsking.add(guest.key);
    const id = `sharing.live.ask.${guest.key}`;
    setStatusNotice({
      id,
      tone: "warn",
      title: "Live session",
      body: `${guest.name} is asking to join`,
    });
    askingNotice.set(guest.key, id);
  }
}
