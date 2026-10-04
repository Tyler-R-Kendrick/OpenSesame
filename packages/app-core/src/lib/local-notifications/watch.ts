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
 *    every mark rather than leave a stale one. It keeps what it has already
 *    announced, so the next good read does not ring the same request again.
 *  - A preference it cannot read is the last one it read, or none of the
 *    doorbells at all: a failure never turns on a place the person turned off.
 *  - Reads are one at a time, and a flood of triggers collapses into one more
 *    read: a script on this origin cannot queue the inbox into a backlog.
 *  - A read that throws is survived; the watcher goes on.
 */

import type { InboxRow } from "../device-inbox.js";
import {
  type LocalDestination,
  type LocalEnvironment,
  allowedDestinations,
  effectiveDestinations,
} from "./destinations.js";
import { type LocalNotice, noticeOf } from "./notice.js";
import { type LocalPreference, QUIET_PREFERENCE } from "./preference.js";

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

/** A trigger that may ring a system notification, as opposed to start or return. */
const mayRing = (why: WatchTrigger) => why !== "start" && why !== "visible";

/** What the watcher remembers between reads. */
type Memory = {
  /** Requests already announced; kept through a read that fails. */
  seen: Set<string>;
  /** The last preference read; kept through a read that fails. */
  preference: LocalPreference;
  cancelLapse: (() => void) | undefined;
};

function clearMarks(ports: WatchPorts): void {
  ports.deliver.inApp(null);
  ports.deliver.tabTitle(0);
  ports.deliver.closeSystem();
}

/** The preference now, or the last one read: a failure turns nothing on. */
async function currentPreference(
  ports: WatchPorts,
  memory: Memory,
): Promise<LocalPreference> {
  try {
    memory.preference = await ports.preference();
  } catch {
    // Keep the last one read.
  }
  return memory.preference;
}

/** Mark what waits, and ring the one that is new if the person is away. */
function show(
  ports: WatchPorts,
  memory: Memory,
  rows: readonly InboxRow[],
  places: readonly LocalDestination[],
  why: WatchTrigger,
): void {
  const count = rows.length;
  ports.deliver.inApp(count > 0 ? count : null);
  ports.deliver.tabTitle(places.includes("tab_title") ? count : 0);
  const first = rows.find((row) => !memory.seen.has(row.ref));
  memory.seen = new Set(rows.map((row) => row.ref));
  const away = ports.hidden();
  if (first !== undefined && mayRing(why) && away && places.includes("system"))
    ports.deliver.system(noticeOf(first), count);
  // Nobody needs a doorbell once nothing waits or they are back.
  if (count === 0 || !away) ports.deliver.closeSystem();
}

/** One read of the inbox, and what it rings. Schedules the next lapse. */
async function readOnce(
  ports: WatchPorts,
  memory: Memory,
  why: WatchTrigger,
  again: (why: WatchTrigger) => void,
  stopped: () => boolean,
): Promise<void> {
  memory.cancelLapse?.();
  let rows: readonly InboxRow[];
  try {
    rows = await ports.list();
  } catch {
    clearMarks(ports);
    return;
  }
  if (stopped()) return;
  const chosen = await currentPreference(ports, memory);
  const places = effectiveDestinations(
    chosen.destinations,
    allowedDestinations(ports.environment()),
  );
  show(ports, memory, rows, places, why);
  const soonest = Math.min(...rows.map((row) => Date.parse(row.expiresAt)));
  if (Number.isFinite(soonest))
    memory.cancelLapse = ports.later(
      () => again("lapse"),
      Math.max(0, soonest - ports.now()) + 50,
    );
}

/**
 * Reads one at a time, with at most one more waiting: a trigger that arrives
 * while one waits is folded into it, keeping the one that may ring. A read
 * that throws is survived.
 */
function readerOf(
  run: (why: WatchTrigger) => Promise<void>,
  stopped: () => boolean,
) {
  let running: Promise<void> | null = null;
  let waiting: WatchTrigger | null = null;
  async function drain(first: WatchTrigger): Promise<void> {
    let why: WatchTrigger | null = first;
    while (why !== null && !stopped()) {
      try {
        await run(why);
      } catch {
        // A delivery that threw is not the end of the watch.
      }
      why = waiting;
      waiting = null;
    }
    running = null;
  }
  return {
    enqueue(why: WatchTrigger): void {
      if (stopped()) return;
      if (running === null) {
        // Deferred a turn, so a caller that sets up state right after
        // starting is read, not raced.
        running = Promise.resolve().then(() => drain(why));
        return;
      }
      if (waiting === null || mayRing(why)) waiting = why;
    },
    /** Resolves once whatever is reading has finished. */
    idle: () => running ?? Promise.resolve(),
  };
}

/** Watch until `signal` aborts, then take every mark down. */
export function watchInbox(
  ports: WatchPorts,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const memory: Memory = {
      seen: new Set(),
      preference: QUIET_PREFERENCE,
      cancelLapse: undefined,
    };
    let stopped = false;
    const isStopped = () => stopped;
    const reader = readerOf(
      (why) =>
        readOnce(ports, memory, why, (next) => reader.enqueue(next), isStopped),
      isStopped,
    );
    const unsubscribe = ports.subscribe(reader.enqueue);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      memory.cancelLapse?.();
      // Whatever is mid-read lands on nothing; the marks come down after it.
      void reader.idle().then(() => {
        clearMarks(ports);
        resolve();
      });
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    reader.enqueue("start");
  });
}
