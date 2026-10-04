/**
 * The ports a watcher test drives it through: an inbox, a preference, an
 * environment, three ways of ringing, and timers it holds in its hand.
 */

import { vi } from "vitest";
import type { InboxRow } from "../device-inbox.js";
import type { LocalEnvironment } from "./destinations.js";
import type { LocalPreference } from "./preference.js";
import {
  type Deliveries,
  type WatchPorts,
  type WatchTrigger,
  watchInbox,
} from "./watch.js";

/** Every place on, as a person who turned the system doorbell on has it. */
export const ALL_PLACES: LocalPreference = {
  version: 1,
  destinations: ["in_app", "tab_title", "system"],
};
export const REF_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const REF_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export function row(ref: string, expiresAt = Date.now() + 300_000): InboxRow {
  return {
    kind: "local-access",
    action: "review",
    ref,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

type RigOptions = {
  environment?: LocalEnvironment;
  preference?: LocalPreference;
  hidden?: boolean;
};

type RigState = {
  rows: InboxRow[];
  hidden: boolean;
  unreadable: boolean;
  /** The preference cannot be read. */
  preferenceUnreadable: boolean;
  /** How many times the inbox was read. */
  reads: number;
  environment: LocalEnvironment;
  preference: LocalPreference;
};

export function rig(options: RigOptions = {}) {
  const calls: string[] = [];
  const deliver: Deliveries = {
    inApp: vi.fn((waiting) => calls.push(`inApp:${waiting}`)),
    tabTitle: vi.fn((waiting) => calls.push(`tab:${waiting}`)),
    system: vi.fn((notice, waiting) =>
      calls.push(`system:${notice.ref}:${waiting}`),
    ),
    closeSystem: vi.fn(() => calls.push("close")),
  };
  const state: RigState = {
    rows: [],
    hidden: options.hidden ?? false,
    unreadable: false,
    preferenceUnreadable: false,
    reads: 0,
    environment: options.environment ?? {
      tabTitle: true,
      system: "granted",
    },
    preference: options.preference ?? ALL_PLACES,
  };
  let trigger: ((why: WatchTrigger) => void) | undefined;
  const timers: { action: () => void; ms: number; live: boolean }[] = [];
  const ports: WatchPorts = {
    list: async () => {
      state.reads += 1;
      if (state.unreadable) throw new Error("locked");
      return state.rows;
    },
    preference: async () => {
      if (state.preferenceUnreadable) throw new Error("unreadable");
      return state.preference;
    },
    environment: () => state.environment,
    hidden: () => state.hidden,
    deliver,
    subscribe: (next) => {
      trigger = next;
      return () => {
        trigger = undefined;
      };
    },
    now: () => Date.now(),
    later: (action, ms) => {
      const timer = { action, ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  const controller = new AbortController();
  const done = watchInbox(ports, controller.signal);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    calls,
    deliver,
    state,
    timers,
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
    fire: async (why: WatchTrigger) => {
      trigger?.(why);
      await settle();
    },
    settle,
    subscribed: () => trigger !== undefined,
  };
}
