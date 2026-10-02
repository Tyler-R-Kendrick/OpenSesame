/**
 * One Prompt API session per document.
 *
 * The browser's weights are already shared across origins; this module makes
 * the *session* shared across our own callers (Support, acquire, a later ask)
 * so opening the panel again does not look like a fresh multi-gigabyte
 * download. Destroying the session is reserved for vault lock / test reset —
 * not for every agent teardown.
 */

import type {
  LocalLanguageModelApi,
  LocalModelProgressListener,
  LocalModelSession,
} from "./detect.js";

type HeldSession = {
  readonly session: LocalModelSession;
  readonly instructions: string;
};

let held: HeldSession | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function obtain(
  api: LocalLanguageModelApi,
  instructions: string,
  monitor: LocalModelProgressListener | null,
  signal: AbortSignal | null,
): Promise<LocalModelSession> {
  if (held !== null && held.instructions === instructions) {
    return held.session;
  }
  if (held !== null) {
    held.session.destroy();
    held = null;
  }
  const session = await api.create({
    initialPrompts:
      instructions.length > 0
        ? [{ role: "system", content: instructions }]
        : [],
    monitor,
    signal,
  });
  held = { session, instructions };
  return session;
}

/**
 * Reuse the live session when the system instruction matches. A different
 * page context replaces it once; that is still one create, not a re-download.
 *
 * Calls are serialized behind `queue`: `api.create` can take as long as a
 * model download, and two callers racing past the `held` check would each
 * create a session, the second assignment orphaning the first — a
 * multi-gigabyte session nothing can ever destroy.
 */
export function obtainLocalModelSession(
  api: LocalLanguageModelApi,
  instructions: string,
  monitor: LocalModelProgressListener | null,
  signal: AbortSignal | null,
): Promise<LocalModelSession> {
  const next = queue.then(() => obtain(api, instructions, monitor, signal));
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Drop the shared session. Called on vault lock and from tests. */
export function releaseLocalModelSession(): void {
  if (held === null) return;
  held.session.destroy();
  held = null;
}

/**
 * Drop the shared session only when it is still the one the caller used. A
 * caller recovering from a failed prompt must not tear down a session another
 * caller created in the meantime.
 */
export function releaseLocalModelSessionIfCurrent(
  session: LocalModelSession,
): void {
  if (held === null || held.session !== session) return;
  releaseLocalModelSession();
}

export function resetLocalModelSessionForTest(): void {
  releaseLocalModelSession();
}
