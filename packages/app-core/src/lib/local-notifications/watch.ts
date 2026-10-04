/**
 * The watcher that tells a person a request is waiting (ADR 0162): it reads
 * the device's inbox when something changes and rings the places the person
 * and the device allow. No server, no push service, no request out of the
 * browser: the inbox is sealed in this vault, a change reaches it by a message
 * between this origin's own tabs, and every place it rings is on this device.
 *
 * It is the pure half. The page hands it its ports — the inbox, the
 * preference, what the browser offers, and the three ways of ringing — so the
 * rules are testable without a document:
 *
 *  - The in-app mark (the bell) and the tab mark (title and badge) follow the
 *    inbox: they say how many wait and clear when none do.
 *  - A system notification rings once, for a request this tab had not seen,
 *    and only when the person is not looking (the tab is hidden) and the
 *    change came from somewhere else. A notice at start-up, or while the page
 *    is in front of the person, would be a doorbell rung at someone already
 *    at the door.
 *  - It never decides anything and carries only `{ kind, action, ref }`.
 *  - An inbox it cannot read is a mark it cannot stand behind: it clears
 *    every mark rather than leave a stale one.
 */

import type { InboxRow } from "../device-inbox.js";
import {
  type LocalDestination,
  type LocalEnvironment,
  allowedDestinations,
  effectiveDestinations,
} from "./destinations.js";
import { type LocalNotice, noticeOf } from "./notice.js";
import { DEFAULT_PREFERENCE, type LocalPreference } from "./preference.js";

/** Why the inbox is being read again. */
export type WatchTrigger =
  | "start"
  | "change"
  | "other-tab"
  | "lapse"
  | "visible"
  | "preference";

/** The three ways a notice rings, and the ways it stops. */
export type Deliveries = Readonly<{
  /** The bell: how many wait, or null for none. */
  inApp(waiting: number | null): void;
  /** The tab's title and the app badge: how many wait, or 0 to clear. */
  tabTitle(waiting: number): void;
  /** A system notification for one notice among `waiting`. */
  system(notice: LocalNotice, waiting: number): void;
  /** Withdraw a system notification that is still showing. */
  closeSystem(): void;
}>;

export type WatchPorts = Readonly<{
  list(): Promise<readonly InboxRow[]>;
  preference(): Promise<LocalPreference>;
  environment(): LocalEnvironment;
  /** The person is not looking at this tab. */
  hidden(): boolean;
  deliver: Deliveries;
  /** Be told of anything that should make the inbox be read again. */
  subscribe(trigger: (why: WatchTrigger) => void): () => void;
  now(): number;
  /** Run `action` after `ms`; returns the cancel. */
  later(action: () => void, ms: number): () => void;
}>;

/** Watch until `signal` aborts, then take every mark down. */
export function watchInbox(
  ports: WatchPorts,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let seen = new Set<string>();
    let cancelLapse: (() => void) | undefined;
    let queue: Promise<void> = Promise.resolve();
    let stopped = false;

    const clear = () => {
      ports.deliver.inApp(null);
      ports.deliver.tabTitle(0);
      ports.deliver.closeSystem();
    };

    async function read(why: WatchTrigger): Promise<void> {
      if (stopped) return;
      cancelLapse?.();
      let rows: readonly InboxRow[];
      try {
        rows = await ports.list();
      } catch {
        seen = new Set();
        clear();
        return;
      }
      if (stopped) return;
      const preference = await ports
        .preference()
        .catch(() => DEFAULT_PREFERENCE);
      const places: readonly LocalDestination[] = effectiveDestinations(
        preference.destinations,
        allowedDestinations(ports.environment()),
      );
      const waiting = rows.length;
      ports.deliver.inApp(waiting > 0 ? waiting : null);
      ports.deliver.tabTitle(places.includes("tab_title") ? waiting : 0);
      const fresh = rows.filter((row) => !seen.has(row.ref));
      seen = new Set(rows.map((row) => row.ref));
      const first = fresh[0];
      const away = ports.hidden();
      if (
        first !== undefined &&
        why !== "start" &&
        why !== "visible" &&
        away &&
        places.includes("system")
      )
        ports.deliver.system(noticeOf(first), waiting);
      // Nobody needs a doorbell once nothing waits or they are back.
      if (waiting === 0 || !away) ports.deliver.closeSystem();
      const soonest = Math.min(...rows.map((row) => Date.parse(row.expiresAt)));
      if (Number.isFinite(soonest))
        cancelLapse = ports.later(
          () => enqueue("lapse"),
          Math.max(0, soonest - ports.now()) + 50,
        );
    }

    function enqueue(why: WatchTrigger): void {
      queue = queue.then(() => read(why));
    }

    const unsubscribe = ports.subscribe(enqueue);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      cancelLapse?.();
      // Whatever is mid-read lands on nothing; the marks come down after it.
      void queue.then(() => {
        clear();
        resolve();
      });
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    enqueue("start");
  });
}
