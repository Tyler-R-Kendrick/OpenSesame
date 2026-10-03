/**
 * Event triggers (ADR 0156): a macro with `on: unlock` runs once when the
 * vault opens, one with `on: enter:<section>` each time that section becomes
 * the page — vim's autocmd over a closed set of events.
 *
 * A trigger runs `navigate` steps only (the keymap refuses anything else), and
 * its motions move the vault list and never the rail (`CommandRun.trigger`).
 * It waits for the arrival's own focus to land first, and it stands down when
 * a person is typing or a dialog holds the keyboard: it never takes focus from
 * someone using it. However a hand-written file is arranged, a loop is bounded
 * three ways: an event fired while a trigger runs is dropped, one event fires
 * at most `TRIGGER_LIMITS.perEventPerSecond` times a second, and all of them
 * at most `TRIGGER_LIMITS.perMinute` times a minute.
 */

import type {
  KeymapEvent,
  Macro,
} from "@opensesame/app-core/lib/keymap/config.js";
import {
  loadKeymap,
  refreshKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { runMacro } from "./keymap-commands.js";
import { showKeymapHelp } from "./keymap-help.js";
import { typing } from "./keymap-targets.js";

/** Tunable: how often a trigger may fire, whatever the keymap file says. */
export const TRIGGER_LIMITS = {
  perEventPerSecond: 3,
  perMinute: 20,
} as const;

/** `/vault/login/x` → `enter:vault`. */
export function sectionEvent(pathname: string): KeymapEvent | null {
  const segment = pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  return /^[a-z][a-z0-9-]*$/.test(segment) ? `enter:${segment}` : null;
}

function busy(): boolean {
  return (
    typing(document.activeElement) ||
    document.querySelector('[role="dialog"][aria-modal="true"]') !== null
  );
}

/** When each event fired lately, newest last: the rate cap reads it. */
const fires: { on: KeymapEvent; at: number }[] = [];
let running = false;

/** Whether one more fire of `on` stays inside the caps; records it if so. */
function withinRate(on: KeymapEvent, now: number): boolean {
  const recent = fires.filter(({ at }) => now - at < 60_000);
  fires.length = 0;
  fires.push(...recent);
  const lastSecond = recent.filter(
    (fire) => fire.on === on && now - fire.at < 1_000,
  );
  if (
    lastSecond.length >= TRIGGER_LIMITS.perEventPerSecond ||
    recent.length >= TRIGGER_LIMITS.perMinute
  )
    return false;
  fires.push({ on, at: now });
  return true;
}

/** Forget the rate history, any run in flight and the unlock flag. Tests only. */
export function resetKeymapEvents(): void {
  fires.length = 0;
  running = false;
  unlockFired = false;
}

export type FireOutcome = Readonly<{
  /** How many macros ran. */
  ran: number;
  /** Macros are bound to the event but a field or a dialog held the keyboard. */
  busy: boolean;
}>;

/** The macros bound to `on`. Own entries only. */
function boundTo(on: KeymapEvent): Macro[] {
  return Object.values(loadKeymap().macros).filter((macro) => macro.on === on);
}

function runBound(
  macros: readonly Macro[],
  navigate: (path: string) => void,
): void {
  running = true;
  try {
    for (const macro of macros) {
      runMacro(macro, {
        event: new KeyboardEvent("keydown"),
        steps: 1,
        hadCount: false,
        navigate,
        showHelp: showKeymapHelp,
        trigger: true,
      });
    }
  } finally {
    running = false;
  }
}

/** Run every macro bound to `on`, and say whether the keyboard was busy. */
export function attemptKeymapEvent(
  on: KeymapEvent,
  navigate: (path: string) => void,
): FireOutcome {
  const macros = boundTo(on);
  if (macros.length === 0 || running) return { ran: 0, busy: false };
  if (busy()) return { ran: 0, busy: true };
  if (!withinRate(on, Date.now())) return { ran: 0, busy: false };
  runBound(macros, navigate);
  return { ran: macros.length, busy: false };
}

/** Run every macro bound to `on`. Returns how many ran. */
export function fireKeymapEvent(
  on: KeymapEvent,
  navigate: (path: string) => void,
): number {
  return attemptKeymapEvent(on, navigate).ran;
}

/**
 * The part of the vault store the unlock trigger reads. Every member is
 * optional: a shell mounted over a partial store (a test double) has no lock
 * feed, and never locks.
 */
export type UnlockFeed = Readonly<{
  onLock?: VaultStore["onLock"];
  subscribe?: VaultStore["subscribe"];
  getSnapshot?: () => Pick<ReturnType<VaultStore["getSnapshot"]>, "status">;
}>;

/** Once per unlock: the flag drops when the vault locks. */
let unlockFired = false;
const watched = new WeakSet<UnlockFeed>();

/** A field or a dialog may hold the keyboard at unlock: ask again, a while. */
export const UNLOCK_RETRY = { everyMs: 500, tries: 20 } as const;

/** After the arrival's focus has landed (`lib/focus.ts` runs on mount). */
function afterLanding(run: () => void): () => void {
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
}

/**
 * Fire `unlock` once the arrival has landed. The flag is set only when the
 * attempt really ran (or had nothing to run), so a cleanup that cancels the
 * timer leaves the next mount to fire it, and a busy keyboard is retried.
 */
function fireUnlock(
  navigate: (path: string) => void,
  settled: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  const attempt = () => {
    const { busy: held } = attemptKeymapEvent("unlock", navigate);
    if (held && retries < UNLOCK_RETRY.tries) {
      retries += 1;
      timer = setTimeout(attempt, UNLOCK_RETRY.everyMs);
      return;
    }
    unlockFired = true;
    settled();
  };
  timer = setTimeout(attempt, 0);
  return () => clearTimeout(timer);
}

/** Reset the unlock flag on every lock of `store`, however long the shell lives. */
function remember(store: UnlockFeed): void {
  if (watched.has(store)) return;
  watched.add(store);
  store.onLock?.(() => {
    unlockFired = false;
  });
}

function isUnlocked(store: UnlockFeed): boolean {
  return (store.getSnapshot?.().status ?? "unlocked") === "unlocked";
}

/** The unlock trigger for as long as the shell holds `store`. */
function watchUnlock(
  store: UnlockFeed,
  navigate: (path: string) => void,
): () => void {
  let cancel: (() => void) | null = null;
  const start = () => {
    if (unlockFired || cancel !== null || !isUnlocked(store)) return;
    cancel = fireUnlock(navigate, () => {
      cancel = null;
    });
  };
  const stop = () => {
    cancel?.();
    cancel = null;
  };
  remember(store);
  const offLock = store.onLock?.(stop);
  const offStore = store.subscribe?.(start);
  start();
  return () => {
    offLock?.();
    offStore?.();
    stop();
  };
}

/** Another tab changed the keymap: `refreshKeymap` emits only on a real difference. */
function onOtherTab(): void {
  refreshKeymap();
}

/** `storage` (another tab wrote) and `focus` (this tab was away) re-read it. */
export function useKeymapStorageSync(): void {
  useEffect(() => {
    window.addEventListener("storage", onOtherTab);
    window.addEventListener("focus", onOtherTab);
    return () => {
      window.removeEventListener("storage", onOtherTab);
      window.removeEventListener("focus", onOtherTab);
    };
  }, []);
}

/**
 * The shell's two triggers. `navigate` changes identity on every path change,
 * so it is held in a ref: neither effect may depend on it, or `enter:vault`
 * would fire again for each item opened inside the vault.
 */
export function useKeymapEvents(
  store: UnlockFeed,
  navigate: (path: string) => void,
): void {
  const { pathname } = useLocation();
  const latest = useRef(navigate);
  useEffect(() => {
    latest.current = navigate;
  });
  const go = useCallback((path: string) => latest.current(path), []);
  useKeymapStorageSync();

  useEffect(() => watchUnlock(store, go), [store, go]);

  // The section's own segment, not the whole path: deeper paths stay quiet.
  const event = sectionEvent(pathname);
  useEffect(() => {
    if (event === null) return;
    return afterLanding(() => fireKeymapEvent(event, go));
  }, [event, go]);
}
