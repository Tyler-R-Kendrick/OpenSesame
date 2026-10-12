/**
 * Tray sentences for the owner's live session (ADR 0163).
 */

import type { HostState } from "@opensesame/app-core/lib/live/host.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";

const seenAsking = new Set<string>();
const askingNotice = new Map<string, string>();
/** Device requests announced, by request id, and the tray row each has. */
const seenDevice = new Set<string>();
const deviceNotice = new Map<string, string>();

/** Forget guests already announced (tests). */
export function resetLiveHostTrayForTests(): void {
  seenAsking.clear();
  askingNotice.clear();
  seenDevice.clear();
  deviceNotice.clear();
}

/** Drop tray rows for guests who were only asking, when the session ends. */
export function clearLiveHostAskingNotices(): void {
  for (const id of [...askingNotice.values(), ...deviceNotice.values()])
    dismissNotice(id);
  askingNotice.clear();
  seenAsking.clear();
  deviceNotice.clear();
  seenDevice.clear();
}

/**
 * Bell/tray when a device asks to use the owner's connections (ADR 0196),
 * and gone again once the owner has answered it or it lapsed. The body names
 * the device and its code, so the owner can compare it at a glance.
 */
export function noteDeviceAsking(state: HostState): void {
  const waiting = new Set(state.devices.pending.map((one) => one.id));
  for (const [request, id] of deviceNotice) {
    if (waiting.has(request)) continue;
    dismissNotice(id);
    deviceNotice.delete(request);
  }
  for (const one of state.devices.pending) {
    if (seenDevice.has(one.id)) continue;
    seenDevice.add(one.id);
    const id = `sharing.live.device.${one.id}`;
    setStatusNotice({
      id,
      tone: "warn",
      title: "Live session",
      body: `${one.name} wants to use your connections (${one.userCode})`,
    });
    deviceNotice.set(one.id, id);
  }
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
