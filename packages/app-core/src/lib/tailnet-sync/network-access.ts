/**
 * Chrome's Local Network Access gate in front of a tailnet drive (ADR 0144).
 *
 * The app is served from a public origin (GitHub Pages) and the drive answers
 * at a tailnet or loopback address, so Chrome holds every request to it on a
 * permission prompt until the person answers — the request does not fail, it
 * waits. A pass nobody asked for (unlock, a change, the minute timer) must not
 * raise that prompt, so it waits for the person; a pass they asked for may,
 * and is given long enough to be answered. A refusal says where to undo it.
 */
import { localNetworkPermission } from "../../ports.js";

export const networkAccessSeams = { query: localNetworkPermission };

/** Long enough for a person to read and answer the browser's prompt. */
export const PROMPT_WAIT_MS = 120_000;

export const NETWORK_DENIED =
  "This browser blocks the site from your local network. Allow local network access for this site in the browser's site settings, then sync again.";
export const NETWORK_PROMPT =
  "Sync is waiting for local network access. Sync now, and allow it when the browser asks.";
export const NETWORK_STILL_ASKING =
  "The browser is still asking for local network access. Allow it, then sync again.";

export type NetworkGate =
  | { go: true; waitMs: number | null }
  | { go: false; reason: string };

/**
 * Whether a pass may reach the drive now. `interactive` is a person's own
 * action (pair, sync now, set up from the drive): only that may raise the
 * prompt, and it is given `waitMs` to be answered.
 */
export async function networkGate(interactive: boolean): Promise<NetworkGate> {
  const access = await networkAccessSeams.query();
  if (access === "denied") return { go: false, reason: NETWORK_DENIED };
  if (access === "prompt") {
    return interactive
      ? { go: true, waitMs: PROMPT_WAIT_MS }
      : { go: false, reason: NETWORK_PROMPT };
  }
  return { go: true, waitMs: null };
}

/**
 * Say what a failed drive request meant when the gate caused it: a refusal
 * fails as a network error, and an unanswered prompt as a timeout. Null when
 * the failure is the drive's own, so its message stands.
 */
export async function explainNetworkFailure(
  error: Error,
): Promise<string | null> {
  const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
  if (!timedOut && error.name !== "TypeError") return null;
  const access = await networkAccessSeams.query();
  if (access === "denied") return NETWORK_DENIED;
  if (access === "prompt" && timedOut) return NETWORK_STILL_ASKING;
  return null;
}
