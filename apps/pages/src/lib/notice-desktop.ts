/**
 * The browser's half of a notice's desktop ring (ADR 0162): a system
 * notification for an arrival while the person is away. Only called when the
 * policy (`arrivalSurface` in app-core `lib/notice-toast.ts`) chose it, so the
 * permission check here is a second guard, not the decision.
 *
 * The words are the local requests' own: generic, the same whoever is asking
 * and whatever it says, because a lock screen reads them too. The notice
 * itself stays in the tray, and a click focuses the app and opens the
 * notice's route when it has one.
 */

import type { Notice } from "@opensesame/app-core/lib/notices.js";

/** The words a desktop ring carries: generic, as a lock screen needs them. */
export const NOTICE_RING_WORDS = {
  title: "Notice waiting",
  body: "A notice is waiting for you.",
} as const;

/** Whether the person is looking somewhere else. */
export function tabAway(): boolean {
  return globalThis.document !== undefined && document.hidden;
}

export function ringDesktopNotice(
  notice: Notice,
  navigate: (to: string) => void,
): void {
  if (globalThis.Notification?.permission !== "granted") return;
  try {
    const made = new Notification(NOTICE_RING_WORDS.title, {
      body: NOTICE_RING_WORDS.body,
      // One ring per notice: a second arrival for the same one replaces it.
      tag: `opensesame-notice-${notice.id}`,
    });
    made.onclick = () => {
      globalThis.focus();
      made.close();
      if (notice.open) navigate(notice.open.to);
    };
  } catch {
    // A browser that will not construct one here (a phone's, which wants a
    // service worker) still has the tray, and the toast when the person
    // returns to the page.
  }
}
