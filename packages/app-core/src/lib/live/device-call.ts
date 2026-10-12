/**
 * One call a device makes through the owner's tab (ADR 0195): run it against
 * the connection port, and hand back only what the wire may carry.
 *
 * The port's answer is rebuilt field by field. Whatever else an operation's
 * result held — a schema, a value the driver keeps for its own use — is not
 * copied, so a field added to a driver's result tomorrow does not become
 * something a device can read today. Text is cleaned of anything that draws
 * nothing or draws over its neighbours, because a terminal will print it;
 * lengths are bounded; and the whole answer is cut to fit one frame, with the
 * cut said aloud.
 *
 * A failure is a code and nothing more. What a provider said about it can
 * hold a token, a URL with a query or a account name, and the device has no
 * need of it.
 */

import type { ConnectionPort, SessionCall } from "./connection-port.js";
import {
  type DeviceErrorCode,
  type DeviceItem,
  ITEMS_MAX,
} from "./device-messages.js";

/** How long one call may take before the owner's tab stops waiting. */
export const CALL_TIMEOUT_MS = 20_000;
/** What a result may weigh: well under a frame (`FRAME_BYTES`). */
export const RESULT_BYTES = 200_000;

const LABEL_MAX = 120;
const ITEM_ID_MAX = 200;
const ITEM_LABEL_MAX = 200;
const URL_MAX = 512;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Printable text within `max` characters, runs of space collapsed. */
function clean(text: string, max: number): string {
  const printable = text.replace(UNSAFE, " ").replace(/\s+/gu, " ").trim();
  return [...printable].slice(0, max).join("");
}

function itemOf(raw: unknown): DeviceItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, label, url } = raw as Record<string, unknown>;
  if (typeof id !== "string") return null;
  const named = clean(id, ITEM_ID_MAX);
  if (named === "") return null;
  const shown = typeof label === "string" ? clean(label, ITEM_LABEL_MAX) : "";
  const item = { id: named, label: shown === "" ? named : shown };
  if (typeof url !== "string") return item;
  const link = url.trim();
  // Only an address a person could open: https, no whitespace or control.
  const safe =
    link.length <= URL_MAX && link.startsWith("https://") && !/\s/u.test(link);
  return safe && clean(link, URL_MAX) === link ? { ...item, url: link } : item;
}

export type Shaped = Readonly<{
  label: string;
  items: readonly DeviceItem[];
  truncated: boolean;
}>;

function weight(shaped: Shaped): number {
  return new TextEncoder().encode(JSON.stringify(shaped)).length;
}

/** A port's answer, rebuilt and cut to what one frame may carry. */
export function shape(result: unknown): Shaped | null {
  if (typeof result !== "object" || result === null) return null;
  const { label, items } = result as Record<string, unknown>;
  if (!Array.isArray(items)) return null;
  const named = typeof label === "string" ? clean(label, LABEL_MAX) : "";
  const kept = items.map(itemOf).filter((item) => item !== null);
  let shaped: Shaped = {
    label: named === "" ? "Result" : named,
    items: kept.slice(0, ITEMS_MAX),
    truncated: kept.length > ITEMS_MAX || kept.length < items.length,
  };
  // Halve until it fits, so a long answer costs lines, never the whole call.
  while (weight(shaped) > RESULT_BYTES && shaped.items.length > 0)
    shaped = {
      ...shaped,
      items: shaped.items.slice(0, Math.floor(shaped.items.length / 2)),
      truncated: true,
    };
  return shaped;
}

export type Called =
  | Readonly<{ ok: true; shaped: Shaped }>
  | Readonly<{ ok: false; error: DeviceErrorCode }>;

/**
 * Make the call. `ended` is aborted when the grant or the session ends; the
 * call's own signal also carries the time limit.
 */
export async function runCall(
  port: ConnectionPort,
  call: Omit<SessionCall, "signal">,
  ended: AbortSignal,
): Promise<Called> {
  // The limit is a timer of ours, not `AbortSignal.timeout`, so a test that
  // fakes the clock moves it too.
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(), CALL_TIMEOUT_MS);
  const signal = AbortSignal.any([ended, limit.signal]);
  try {
    const result = await port.invoke({ ...call, signal });
    if (signal.aborted) return { ok: false, error: "temporarily_unavailable" };
    const shaped = shape(result);
    return shaped
      ? { ok: true, shaped }
      : { ok: false, error: "upstream_error" };
  } catch {
    return {
      ok: false,
      error: signal.aborted ? "temporarily_unavailable" : "upstream_error",
    };
  } finally {
    clearTimeout(timer);
  }
}
