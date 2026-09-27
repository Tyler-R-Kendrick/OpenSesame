/**
 * How the tab that resets this browser (`browser-reset.ts`) tells the others.
 * Its own module, importing nothing but the ports and the write halt, so the
 * shell's entry can listen from the first moment without loading the reset
 * itself — and so nothing here may throw at import: `main.tsx` loads it before
 * anything renders.
 */

import { lockManager, openBroadcast } from "../ports.js";
import { haltStorageWrites } from "./storage-halt.js";

const CHANNEL = "opensesame.browser-reset";

/**
 * The Web Lock the resetting tab holds from before its first message until
 * after its last. A tab that heard the reset start is granted it only once
 * the reset is over, however long that took.
 */
export const RESET_LOCK = "opensesame.browser-reset";

let tab: string | null = null;

/**
 * A random id for this tab, made when first needed. `crypto.randomUUID` is
 * absent before Safari 15.4 and outside a secure context, where
 * `getRandomValues` still answers.
 */
function randomTabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Absent (a TypeError calling it), or present and refused.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** This tab, so it can tell its own announcement from another tab's. */
function thisTab(): string {
  tab ??= randomTabId();
  return tab;
}

/**
 * `start` goes out before anything is cleared, `done` once everything has
 * been attempted. A message with no phase is read as `done`.
 */
export type ResetPhase = "start" | "done";

type ResetMessage = Readonly<{
  kind: "reset";
  tab: string;
  phase?: ResetPhase;
}>;

/**
 * The last resort: how long a tab that heard `start` waits before it reloads
 * with neither `done` nor the lock — a browser without Web Locks (Safari
 * before 15.4) whose resetting tab was closed part way.
 */
const CEILING_MS = 120_000;

function resetFromElsewhere(
  event: MessageEvent<Partial<ResetMessage> | null>,
): ResetPhase | null {
  // Anything else on the channel (a string, null, an older shape) has no
  // `kind` of "reset" and is ignored.
  const data = event.data;
  if (data?.kind !== "reset" || data.tab === thisTab()) return null;
  return data.phase === "start" ? "start" : "done";
}

/**
 * Tell every other tab of this origin that its storage is going (`start`),
 * before anything is cleared, so the others stop writing first; and that it
 * has gone (`done`), so they reload onto the emptied storage — never onto
 * storage half cleared, where a fresh boot would write its first visit
 * into what the reset has yet to reach.
 */
export function announceBrowserReset(phase: ResetPhase): void {
  const channel = openBroadcast(CHANNEL);
  if (!channel) return;
  channel.postMessage({
    kind: "reset",
    tab: thisTab(),
    phase,
  } satisfies ResetMessage);
  channel.close();
}

/**
 * Run `handler` when another tab of this origin has reset the browser.
 * Writes stop as soon as the reset starts — this tab's memory describes
 * storage that is going, and anything it wrote back would outlive the reset
 * — and the handler (the shell reloads) runs once it is over: on `done`, or
 * when the reset lock is released (a resetting tab closed part way releases
 * it too), or at the ceiling.
 */
export function onBrowserReset(handler: () => void): () => void {
  const channel = openBroadcast(CHANNEL);
  if (!channel) return () => undefined;
  let finished = false;
  let ceiling: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (ceiling !== null) clearTimeout(ceiling);
    handler();
  };
  const waitForTheReset = () => {
    if (ceiling !== null || finished) return;
    ceiling = setTimeout(finish, CEILING_MS);
    lockManager()
      ?.request(RESET_LOCK, () => undefined)
      .then(finish, () => undefined);
  };
  const listener = (event: MessageEvent<Partial<ResetMessage> | null>) => {
    const phase = resetFromElsewhere(event);
    if (phase === null) return;
    haltStorageWrites();
    if (phase === "done") finish();
    else waitForTheReset();
  };
  channel.addEventListener("message", listener);
  return () => {
    finished = true;
    if (ceiling !== null) clearTimeout(ceiling);
    channel.removeEventListener("message", listener);
    channel.close();
  };
}
