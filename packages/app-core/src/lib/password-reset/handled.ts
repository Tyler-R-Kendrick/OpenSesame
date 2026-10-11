/**
 * Which reset messages this device has already acted on, so a reload, a second
 * tab or a message that stays in the look-back window does not tell a person,
 * or ask the Host, twice. Two ledgers: a message was announced, and the
 * ceremony was handed it.
 *
 * A key is a digest of the login, the site and the message, never the three
 * written out: the file is sealed at rest like every stored value (ADR 0149),
 * and a name that is not there cannot leak. Entries age out with the window the
 * reader looks back over.
 */

import {
  type JsonValue,
  isJsonObject,
  isNumber,
  overlapCast,
} from "@opensesame/os-domain";
import { kvDelete, kvGet, kvSet } from "../kv.js";

export const HANDLED_KEY = "password-reset-handled.v1";

export type Ledger = "announced" | "handedOff";

/** How far back the reader looks, and so how long an entry is worth keeping. */
export const LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** Digest -> when it was filed (ms). */
type Filed = Map<string, number>;

type Stored = { announced: Filed; handedOff: Filed };

function filedFrom(value: JsonValue | undefined): Filed {
  const filed: Filed = new Map();
  if (value === undefined || !isJsonObject(value)) return filed;
  for (const [key, at] of Object.entries(value)) {
    if (isNumber(at)) filed.set(key, at);
  }
  return filed;
}

function read(): Stored {
  const text = kvGet(HANDLED_KEY);
  const none = { announced: new Map(), handedOff: new Map() };
  if (!text) return none;
  try {
    const parsed = overlapCast(JSON.parse(text));
    if (!isJsonObject(parsed)) return none;
    return {
      announced: filedFrom(parsed.announced),
      handedOff: filedFrom(parsed.handedOff),
    };
  } catch {
    return none;
  }
}

function write(stored: Stored): void {
  kvSet(
    HANDLED_KEY,
    JSON.stringify({
      announced: Object.fromEntries(stored.announced),
      handedOff: Object.fromEntries(stored.handedOff),
    }),
  );
}

/** The digest a login, a site and a message are filed under. */
export async function handledKey(
  loginId: string,
  origin: string,
  messageId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${loginId}\n${origin}\n${messageId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isHandled(ledger: Ledger, key: string): boolean {
  return read()[ledger].has(key);
}

function keepRecent(entries: Filed, now: number): Filed {
  return new Map([...entries].filter(([, at]) => now - at <= LOOKBACK_MS));
}

/** Record `key`, and let go of entries older than the look-back window. */
export function markHandled(ledger: Ledger, key: string, now: number): void {
  const stored = read();
  const fresh: Stored = {
    announced: keepRecent(stored.announced, now),
    handedOff: keepRecent(stored.handedOff, now),
  };
  fresh[ledger].set(key, now);
  write(fresh);
}

/** Forget a hand-off that did not land, so it is tried again. */
export function unmarkHandled(ledger: Ledger, key: string): void {
  const stored = read();
  if (stored[ledger].delete(key)) write(stored);
}

export function clearHandledForTest(): void {
  kvDelete(HANDLED_KEY);
}
