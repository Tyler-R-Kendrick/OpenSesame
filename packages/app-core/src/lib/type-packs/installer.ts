/**
 * Switching an item-type pack on or off (ADR 0165).
 *
 * Switching on is the cue to download and install: the pack's chunk is
 * fetched, its digest and definition checked, a sealed copy kept for the next
 * boot and offline use, and only then does the type exist. Every step is
 * announced through `state.ts`, and the work is queued and paced so the page
 * is never held:
 *
 *   - one pack at a time, so "switch on all" is a line, not a burst;
 *   - the main thread is handed back before each step and between packs
 *     (`yieldToMain`), so taps, scrolling and a typing cursor keep up while
 *     eighteen definitions arrive;
 *   - nothing reloads the page and nothing re-runs the capability plan: the
 *     registry notices the new pack by its version counter.
 *
 * Switching off while a pack is still on its way cancels it; switching off a
 * pack that is installed drops it. A type the open vault holds items of
 * cannot be dropped — the items would lose their form — and says so.
 */

import {
  type PackFetcher,
  dropPack,
  importPackText,
  isPackLoaded,
  packEntry,
  registerPack,
  verifyPackText,
} from "@opensesame/vault-item-types";
import { dismissNotice } from "../notices.js";
import { announcePacks, announceSeams } from "./announce.js";
import { updateStoredPacks } from "./persist.js";
import { neededBy, packsNeeded } from "./requires.js";
import {
  getPackSnapshot,
  isBusy,
  resetSettled,
  setStatus,
  statusOf,
} from "./state.js";

/** Seams a test replaces; the defaults are the browser's. */
type PackSeams = {
  fetchText: PackFetcher;
  yieldToMain: () => Promise<void>;
};

export const packSeams: PackSeams = {
  fetchText: importPackText,
  yieldToMain: yieldToMainDefault,
};

/** The Prioritized Task Scheduling API, where the browser has it. */
type TaskSchedulerGlobal = {
  scheduler?: { yield?: () => Promise<void> };
};

/**
 * Hand the main thread back. `scheduler.yield()` keeps this task's priority
 * where it exists; a macrotask is the fallback everywhere else.
 */
function yieldToMainDefault(): Promise<void> {
  /* SAFETY: the global's declared contract marks `scheduler` optional and the
     check below is the runtime proof before it is used; absence falls through
     to the macrotask. */
  const { scheduler } = globalThis as TaskSchedulerGlobal;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const queue: string[] = [];
const cancelled = new Set<string>();
/** Packs fetched because the vault needs them, not because a person chose them. */
const transient = new Set<string>();
let draining = false;

/** How many downloads may be in the air at once. Installs never overlap. */
const FETCH_AHEAD = 6;

type Fetched = { ok: true; text: string } | { ok: false; reason: string };

/** Downloads started and not yet taken by the install loop. */
const fetching = new Map<string, Promise<Fetched>>();

/**
 * Start a download. Fetching waits on the network and never on the main
 * thread, so a few go at once and the wall time of a bulk switch is the
 * slowest chunk, not the sum of all of them; only installing is one at a time.
 */
function startFetch(id: string): Promise<Fetched> {
  const started = fetching.get(id);
  if (started !== undefined) return started;
  setStatus(id, { phase: "downloading" });
  const download = packSeams.fetchText(id).then(
    (text): Fetched => ({ ok: true, text }),
    (error): Fetched => ({
      ok: false,
      reason: error instanceof Error ? error.message : "It did not download.",
    }),
  );
  fetching.set(id, download);
  return download;
}

function prefetch(): void {
  for (const id of queue.slice(0, FETCH_AHEAD)) {
    if (!cancelled.has(id)) startFetch(id);
  }
}

async function installOne(id: string): Promise<void> {
  const entry = packEntry(id);
  if (entry === undefined) return;
  const download = startFetch(id);
  await packSeams.yieldToMain();
  const got = await download;
  fetching.delete(id);
  if (cancelled.has(id)) return;
  if (!got.ok) {
    setStatus(id, { phase: "failed", reason: got.reason });
    return;
  }
  try {
    setStatus(id, { phase: "installing" });
    await packSeams.yieldToMain();
    const definition = await verifyPackText(id, got.text);
    if (cancelled.has(id)) return;
    if (!transient.has(id)) {
      await updateStoredPacks((stored) => {
        stored.set(id, { sha256: entry.sha256, text: got.text });
      });
      if (cancelled.has(id)) {
        await updateStoredPacks((stored) => {
          stored.delete(id);
        });
        return;
      }
    }
    registerPack(definition, got.text);
    setStatus(id, { phase: "on" });
  } catch (error) {
    if (cancelled.has(id)) return;
    setStatus(id, {
      phase: "failed",
      reason: error instanceof Error ? error.message : "It did not install.",
    });
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) break;
      if (cancelled.has(id)) continue;
      prefetch();
      announcePacks();
      await installOne(id);
      announcePacks();
      await packSeams.yieldToMain();
    }
  } finally {
    draining = false;
    cancelled.clear();
    fetching.clear();
    announcePacks();
    if (getPackSnapshot().pending === 0) resetSettled();
  }
}

/**
 * Switch a pack on: queue it, and the drain downloads and installs it.
 *
 * `keep: false` is for a type the open vault already holds items of: it is
 * installed for this document so those items open, and not remembered as a
 * choice, so locking the vault never leaves a switch the person did not press.
 */
export type EnableOptions = { keep?: boolean };

export function enablePack(id: string, options: EnableOptions = {}): void {
  if (packEntry(id) === undefined) return;
  // A type that cannot work without another switches it on too (ADR 0178).
  for (const need of packsNeeded(id)) enablePack(need, options);
  const { phase } = statusOf(id);
  if (phase === "on" || (isBusy(phase) && !cancelled.has(id))) return;
  cancelled.delete(id);
  if (options.keep === false) transient.add(id);
  else transient.delete(id);
  dismissNotice(`type-pack:${id}`);
  setStatus(id, { phase: "queued" });
  queue.push(id);
  // A pack joining while others are installing starts its download at once.
  prefetch();
  announcePacks();
  void drain();
}

export function enablePacks(
  ids: readonly string[],
  options: EnableOptions = {},
): void {
  for (const id of ids) enablePack(id, options);
}

export type DisableOutcome = Readonly<
  { ok: true } | { ok: false; reason: string }
>;

/** Switch a pack off: cancel it on its way, or drop it once installed. */
export async function disablePack(id: string): Promise<DisableOutcome> {
  const entry = packEntry(id);
  if (entry === undefined) return { ok: false, reason: "Not an item type." };
  const { phase } = statusOf(id);
  if (isBusy(phase)) {
    cancelled.add(id);
    fetching.delete(id);
    const at = queue.indexOf(id);
    if (at >= 0) queue.splice(at, 1);
    setStatus(id, { phase: "off" });
    announcePacks();
    return { ok: true };
  }
  const needing = neededBy(id, (pack) => statusOf(pack).phase === "on");
  if (needing !== null) {
    return { ok: false, reason: `${needing} needs ${entry.title}.` };
  }
  const held = getPackSnapshot().counts.get(id) ?? 0;
  if (held > 0) {
    return {
      ok: false,
      reason:
        held === 1
          ? `${entry.title} has 1 item in this vault.`
          : `${entry.title} has ${held} items in this vault.`,
    };
  }
  if (isPackLoaded(id)) dropPack(id);
  setStatus(id, { phase: "off" });
  announcePacks();
  try {
    await updateStoredPacks((stored) => {
      stored.delete(id);
    });
  } catch {
    // The type is off for this session; the stored copy is cleared by the
    // next change. Nothing the person holds depends on it.
  }
  return { ok: true };
}

announceSeams.retry = (id) => enablePack(id);
