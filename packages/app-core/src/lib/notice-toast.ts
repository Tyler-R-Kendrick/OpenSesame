/**
 * Toasts: the transient echo of a notice (ADR 0162, on ADR 0084). A notice
 * still lands in the tray and stays there; a toast says so once, and exactly
 * one surface rings for each arrival:
 *
 *  - the page is in front of the person: an in-app toast, and no system
 *    notification, so the same arrival never rings twice;
 *  - the page is away and desktop notifications are on: one system
 *    notification, and no toast, which nobody would see;
 *  - the page is away and desktop is off: the tray alone, as before.
 *
 * Pure policy and a small bus. The browser's `Notification` and the toast's
 * markup live in apps/pages, which subscribes here. Desktop notifications are
 * on when the local-notifications capability says so: its watcher sets the
 * flag from the person's preference and the browser's permission, and clears
 * it when the vault locks, so a capability that is off never turns it on.
 */

import type { Notice, NoticeOpen, NoticeTone } from "./notices.js";

/** Which one surface an arrival rings, or none when only the tray holds it. */
export type ArrivalSurface = "toast" | "desktop";

/** The one surface an arrival rings, decided by what the person can see. */
export function arrivalSurface(input: {
  away: boolean;
  desktop: boolean;
}): ArrivalSurface | null {
  if (!input.away) return "toast";
  return input.desktop ? "desktop" : null;
}

/** What a toast says: the tray notice's own words, and where it leads. */
export type ToastMessage = Readonly<{
  id: string;
  tone: NoticeTone;
  title: string;
  body: string;
  open?: NoticeOpen;
}>;

export function toastOf(notice: Notice): ToastMessage {
  return {
    id: notice.id,
    tone: notice.tone ?? "info",
    title: notice.title,
    body: notice.body,
    open: notice.open,
  };
}

type ToastListener = (toast: ToastMessage) => void;
const toastListeners = new Set<ToastListener>();

/** Show a toast in the page. A toast that nobody is listening for is dropped. */
export function showToast(toast: ToastMessage): void {
  for (const listener of [...toastListeners]) listener(toast);
}

export function subscribeToasts(listener: ToastListener): () => void {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}

let desktop = false;

/** Whether a system notification may ring for this device now. */
export function setDesktopRinging(on: boolean): void {
  desktop = on;
}

export function desktopRinging(): boolean {
  return desktop;
}
