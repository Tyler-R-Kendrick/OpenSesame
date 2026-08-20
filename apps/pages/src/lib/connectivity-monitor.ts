/**
 * One supervisor for every reachability probe in this tab.
 *
 * Before this, each component that wanted to know whether Host was up ran its
 * own probe in its own effect. Six of them do, so a single Settings visit cost
 * sixteen Host requests — and none of them ever ran again, because the app
 * shell that hosts the connectivity bar never remounts. The bar showed
 * first-paint truth for the life of the tab: a plane could die or come back
 * and nothing noticed.
 *
 * So probing moves here. Components subscribe; the monitor owns the schedule,
 * dedupes in-flight work, and pushes one answer to everybody.
 *
 * Cadence is adaptive rather than fixed. Polling every few seconds forever is
 * rude to the daemon and to a laptop battery, and polling slowly is useless
 * exactly when something is broken and you are watching. So: relaxed while
 * everything is green, tight the moment anything is not, backing off if it
 * stays broken, and asleep entirely when the tab is hidden or the browser is
 * offline — with an immediate check the instant either of those changes.
 */

import { useSyncExternalStore } from "react";
import { isOnline, subscribeConnectivity } from "./connectivity.js";
import { probeDaemon } from "./daemon.js";
import {
  hostBase,
  identityBase,
  probeHostDetailed,
  probeIdentityDetailed,
} from "./identity.js";
import { type FailureClass, classifyThrown } from "./probe-failure.js";
import { loadSettings, pageIsLoopback, subscribeSettings } from "./settings.js";
import { isLoopbackUrl, normalizeTailnetBase } from "./urls.js";

export type { FailureClass } from "./probe-failure.js";

export type ProbeTarget = "host" | "identity" | "machine";

export type TargetHealth = "unknown" | "reachable" | "unreachable";

export type TargetState = {
  health: TargetHealth;
  failure: FailureClass | null;
  /** Epoch ms of the last completed probe, or null if never probed. */
  lastCheckedAt: number | null;
  /** A probe is in flight right now. */
  checking: boolean;
};

export type MonitorSnapshot = {
  offline: boolean;
  host: TargetState;
  identity: TargetState;
  machine: TargetState;
  /** Epoch ms the next scheduled sweep is due, or null when parked. */
  nextCheckAt: number | null;
};

/** Everything is green: check rarely enough to be free. */
export const HEALTHY_MS = 30_000;
/** Something is not: check often enough to catch the recovery. */
export const DEGRADED_MS = 5_000;
/** …but not forever. A target that stays down backs off to this. */
export const MAX_MS = 60_000;
const BACKOFF = 1.6;
/** Spread repeated sweeps so N tabs never form a thundering herd. */
const JITTER = 0.15;

/**
 * How many consecutive failures before a green light goes amber.
 *
 * One blip should not flip the bar — a dropped packet during a suspend/resume
 * is not an outage, and a glyph that flickers teaches people to ignore it.
 * Recovery is not damped: the first success restores green immediately,
 * because being slow to report good news is its own kind of lie.
 */
export const STRIKES_TO_FAIL = 2;

type Internal = TargetState & { strikes: number };

function blank(): Internal {
  return {
    health: "unknown",
    failure: null,
    lastCheckedAt: null,
    checking: false,
    strikes: 0,
  };
}

const state: Record<ProbeTarget, Internal> = {
  host: blank(),
  identity: blank(),
  machine: blank(),
};

let offline = !isOnline();
let nextCheckAt: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let consecutiveDegradedSweeps = 0;
let running = false;
let teardown: Array<() => void> = [];

const listeners = new Set<() => void>();

// useSyncExternalStore compares snapshots by identity, so a fresh object on
// every read would re-render forever. Rebuild only when something changed.
let snapshot: MonitorSnapshot = buildSnapshot();
let dirty = false;

function buildSnapshot(): MonitorSnapshot {
  const pick = (t: ProbeTarget): TargetState => ({
    health: state[t].health,
    failure: state[t].failure,
    lastCheckedAt: state[t].lastCheckedAt,
    checking: state[t].checking,
  });
  return {
    offline,
    host: pick("host"),
    identity: pick("identity"),
    machine: pick("machine"),
    nextCheckAt,
  };
}

function emit(): void {
  if (!dirty) return;
  dirty = false;
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

function touch(): void {
  dirty = true;
}

export function connectivitySnapshot(): MonitorSnapshot {
  return snapshot;
}

/**
 * True when at least one target is failing, or has just started to.
 *
 * This deliberately counts *strikes*, not the damped health. Reading the
 * hysteresis-filtered verdict here would be circular: the first failure would
 * not tighten the cadence, so the second probe that confirms it would not
 * arrive for another full healthy interval — a real outage taking a minute to
 * surface, and the tight cadence only ever engaging after the fact. Counting
 * the first strike means a failure is confirmed one short interval later.
 */
function degraded(): boolean {
  return (["host", "identity", "machine"] as const).some(
    (t) => state[t].health === "unreachable" || state[t].strikes > 0,
  );
}

function jittered(ms: number): number {
  // Deterministic jitter would defeat the point; Math.random is right here.
  const spread = ms * JITTER;
  return Math.round(ms - spread + Math.random() * spread * 2);
}

function nextDelay(): number {
  if (!degraded()) {
    consecutiveDegradedSweeps = 0;
    return jittered(HEALTHY_MS);
  }
  const backed = DEGRADED_MS * BACKOFF ** consecutiveDegradedSweeps;
  return jittered(Math.min(backed, MAX_MS));
}

function hidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/** Probing a hidden tab spends battery on an answer nobody can see. */
function parked(): boolean {
  return offline || hidden();
}

function schedule(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!running || parked() || listeners.size === 0) {
    if (nextCheckAt !== null) {
      nextCheckAt = null;
      touch();
    }
    emit();
    return;
  }
  const delay = nextDelay();
  nextCheckAt = Date.now() + delay;
  touch();
  emit();
  timer = setTimeout(() => {
    timer = null;
    void sweep();
  }, delay);
}

/** Whether this page may even attempt `${daemonApi}/health`. */
export function daemonIsProbable(
  daemonApi: string,
  loopbackPage: boolean,
): boolean {
  const base = normalizeTailnetBase(daemonApi);
  if (!base) return false;
  return loopbackPage || !isLoopbackUrl(base);
}

async function probeMachine(): Promise<{
  ok: boolean;
  failure: FailureClass | null;
}> {
  const daemonApi = loadSettings().daemonApi.trim();
  if (!daemonApi || !daemonIsProbable(daemonApi, pageIsLoopback())) {
    // Not a failure — there is nothing to reach. `unset` is the tone for this.
    return { ok: false, failure: null };
  }
  try {
    const health = await probeDaemon(daemonApi);
    return health.service === "opensesame-daemon"
      ? { ok: true, failure: null }
      : { ok: false, failure: "not-opensesame" };
  } catch (error) {
    // probeDaemon throws a plain Error for a wrong-service answer, which is a
    // very different problem from nothing listening at all.
    if (
      error instanceof Error &&
      /not an OpenSesame daemon/i.test(error.message)
    ) {
      return { ok: false, failure: "not-opensesame" };
    }
    return { ok: false, failure: classifyThrown(error) };
  }
}

async function probeOne(target: ProbeTarget): Promise<void> {
  const entry = state[target];
  // One in-flight probe per target: a slow answer must not stack up behind
  // itself when the cadence is tight.
  if (entry.checking) return;
  entry.checking = true;
  touch();
  emit();

  let ok = false;
  let failure: FailureClass | null = null;
  try {
    if (target === "machine") {
      const result = await probeMachine();
      ok = result.ok;
      failure = result.failure;
    } else {
      const base = target === "host" ? hostBase() : identityBase();
      if (!base.trim()) {
        // Nothing configured is not a failure — `unset` is the tone for it.
        ok = false;
        failure = null;
      } else {
        const result =
          target === "host"
            ? await probeHostDetailed()
            : await probeIdentityDetailed();
        ok = result.health === "reachable";
        failure = ok ? null : (result.failure ?? "unreachable");
      }
    }
  } catch (error) {
    ok = false;
    failure = classifyThrown(error);
  }

  entry.checking = false;
  entry.lastCheckedAt = Date.now();
  if (ok) {
    // Good news is never damped.
    entry.strikes = 0;
    entry.health = "reachable";
    entry.failure = null;
  } else {
    entry.strikes += 1;
    entry.failure = failure;
    if (entry.strikes >= STRIKES_TO_FAIL || entry.health === "unknown") {
      entry.health = "unreachable";
    }
  }
  touch();
  emit();
}

async function sweep(): Promise<void> {
  if (parked()) {
    schedule();
    return;
  }
  const before = degraded();
  await Promise.all([
    probeOne("host"),
    probeOne("identity"),
    probeOne("machine"),
  ]);
  const after = degraded();
  // Back off only while it stays broken; a recovery resets the ladder so the
  // next failure is caught quickly again.
  consecutiveDegradedSweeps = after
    ? before
      ? consecutiveDegradedSweeps + 1
      : 0
    : 0;
  schedule();
}

/**
 * Probe every target now, resetting the backoff ladder.
 *
 * This is what a person asking counts as: opening a ceremony, pressing Check
 * now, coming back to the tab, or the radio coming back on.
 */
export function checkNow(): void {
  consecutiveDegradedSweeps = 0;
  if (parked()) {
    schedule();
    return;
  }
  void sweep();
}

function setOffline(next: boolean): void {
  if (offline === next) return;
  offline = next;
  if (next) {
    // Do not relabel what we last knew — just stop claiming it is current.
    for (const target of ["host", "identity", "machine"] as const) {
      state[target].failure = "offline";
    }
  }
  touch();
  emit();
  if (next) schedule();
  else checkNow();
}

function start(): void {
  if (running) return;
  running = true;
  teardown = [
    // subscribeConnectivity reports *online*; this flag is its opposite.
    subscribeConnectivity((online) => setOffline(!online)),
    // A base URL changing makes every cached verdict about it meaningless.
    subscribeSettings(() => checkNow()),
  ];
  if (typeof document !== "undefined") {
    const onVisibility = () => {
      if (document.visibilityState === "visible") checkNow();
      else schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    teardown.push(() =>
      document.removeEventListener("visibilitychange", onVisibility),
    );
  }
  checkNow();
}

function stop(): void {
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  nextCheckAt = null;
  for (const off of teardown) off();
  teardown = [];
  touch();
  emit();
}

export function subscribeConnectivityMonitor(listener: () => void): () => void {
  listeners.add(listener);
  // Lazy: nothing probes until something is actually watching, so the unlock
  // screen and the tests stay quiet.
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** Test seam: drop all state and timers between cases. */
export function resetConnectivityMonitorForTests(): void {
  stop();
  listeners.clear();
  state.host = blank();
  state.identity = blank();
  state.machine = blank();
  offline = !isOnline();
  consecutiveDegradedSweeps = 0;
  dirty = true;
  snapshot = buildSnapshot();
  dirty = false;
}

/** Subscribe a component to the monitor. Starts it on the first subscriber. */
export function useConnectivityMonitor(): MonitorSnapshot {
  return useSyncExternalStore(
    subscribeConnectivityMonitor,
    connectivitySnapshot,
    connectivitySnapshot,
  );
}
