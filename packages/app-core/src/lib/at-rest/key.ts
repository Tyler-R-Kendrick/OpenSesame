/**
 * The device's at-rest data key (ADR 0148): the key every value the app
 * leaves in Web Storage, origin-private files or IndexedDB is sealed under.
 *
 * The host keeps it (`Ports.atRestKeys`): the browser wraps it under a
 * non-extractable key in IndexedDB, the CLI keeps it in a file of its own,
 * a test holds it in memory. Three states:
 *
 * - **pending** — the host keeps a key and it has not loaded yet. Nothing is
 *   written to disk; a write waits in memory until the key arrives.
 * - **durable** — loaded. Writes are sealed and persist.
 * - **ephemeral** — the host keeps no key, could not produce one in time,
 *   or lost the one its seals were made under (`sealed-evidence.ts`). A
 *   fresh key lives in memory for this document only, and the stores stop
 *   writing to disk at all: a browser that refuses IndexedDB keeps nothing
 *   past the tab rather than keep it in the clear, and nothing already on
 *   disk is overwritten with a seal the next document could not open.
 */

import { host } from "../../host.js";
import { AT_REST_KEY_BYTES } from "./cipher.js";

export type AtRestKey = Readonly<{
  key: Uint8Array;
  /** False when the key dies with this document. */
  durable: boolean;
}>;

let current: AtRestKey | null = null;
let loading: Promise<AtRestKey> | null = null;
const readyListeners = new Set<(key: AtRestKey) => void>();

function ephemeral(): AtRestKey {
  return {
    key: crypto.getRandomValues(new Uint8Array(AT_REST_KEY_BYTES)),
    durable: false,
  };
}

function checked(key: Uint8Array): Uint8Array {
  if (key.length !== AT_REST_KEY_BYTES) {
    throw new Error("at-rest key has the wrong length");
  }
  return key;
}

function settle(next: AtRestKey): AtRestKey {
  if (current) return current;
  current = next;
  const listeners = [...readyListeners];
  readyListeners.clear();
  // One listener's failure (a full quota on flush) must neither reject the
  // load nor cost the others their turn.
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      /* the listener keeps what it could not write */
    }
  }
  return next;
}

/**
 * How long boot waits for the browser to produce the key. An IndexedDB open
 * that never answers (a stuck version change, a WebKit fault) must not leave
 * the front end blank (ADR 0090): past this, the document runs ephemeral —
 * nothing written, nothing on disk overwritten — and the next load retries.
 */
export const AT_REST_LOAD_TIMEOUT_MS = 5000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("at-rest key load timed out")),
      AT_REST_LOAD_TIMEOUT_MS,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function startLoading(load: () => Promise<Uint8Array>): Promise<AtRestKey> {
  if (!loading) {
    loading = withTimeout(load())
      .then(checked)
      .then(
        (key) => settle({ key, durable: true }),
        () => settle(ephemeral()),
      );
  }
  return loading;
}

/**
 * The key if it can be had now, loading it synchronously where the host
 * allows; null while a host's asynchronous load is still pending (and starts
 * that load).
 */
export function atRestKeyNow(): AtRestKey | null {
  if (current) return current;
  const port = host().atRestKeys;
  if (!port) return settle(ephemeral());
  if (port.loadSync) {
    try {
      return settle({ key: checked(port.loadSync()), durable: true });
    } catch {
      return settle(ephemeral());
    }
  }
  void startLoading(() => port.load());
  return null;
}

/** The key if it has settled, without starting a load. */
export function atRestSettled(): AtRestKey | null {
  return current;
}

/** The key, once the host has produced it (or given up and gone ephemeral). */
export function atRestReady(): Promise<AtRestKey> {
  const now = atRestKeyNow();
  if (now) return Promise.resolve(now);
  const port = host().atRestKeys;
  // atRestKeyNow() settles whenever there is no asynchronous load to wait for.
  if (!port) return Promise.resolve(settle(ephemeral()));
  return startLoading(() => port.load());
}

/** Called once, when the key settles (at once if it already has). */
export function onAtRestReady(listener: (key: AtRestKey) => void): () => void {
  if (current) {
    listener(current);
    return () => {};
  }
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

/** Forget the key (tests, and a document whose storage was just reset). */
export function forgetAtRestKeyForTest(): void {
  current = null;
  loading = null;
  readyListeners.clear();
}
