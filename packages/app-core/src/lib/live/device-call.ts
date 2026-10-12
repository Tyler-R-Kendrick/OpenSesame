/**
 * One call a device makes through the owner's tab (ADR 0196): run it against
 * the connection port, and hand back only what the wire may carry.
 *
 * The port's answer is rebuilt field by field. Whatever else an operation's
 * result held at run time — a schema, a value a driver keeps for its own
 * use — is not copied, so a field added to a driver's result tomorrow does not
 * become something a device can read today. Text is cleaned of anything that
 * draws nothing or draws over its neighbours, because a terminal will print
 * it; lengths are bounded; and the whole answer is cut to fit one frame, with
 * the cut said aloud.
 *
 * A failure is a code and nothing more. What a provider said about it can
 * hold a token, a URL with a query or an account name, and the device has no
 * need of it.
 */

import {
  type ConnectionPort,
  InvalidCall,
  type SessionCall,
  type SessionResult,
} from "./connection-port.js";
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

/** An address a person could open: https, whole, nothing in it to draw. */
function linkOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const link = url.trim();
  const openable =
    link.length <= URL_MAX && link.startsWith("https://") && !/\s/u.test(link);
  return openable && clean(link, URL_MAX) === link ? link : undefined;
}

function lineOf(item: DeviceItem): DeviceItem | null {
  const id = clean(item.id, ITEM_ID_MAX);
  if (id === "") return null;
  const label = clean(item.label, ITEM_LABEL_MAX);
  const link = linkOf(item.url);
  return link === undefined
    ? { id, label: label === "" ? id : label }
    : { id, label: label === "" ? id : label, url: link };
}

/** What a device is told of an operation: labelled lines, and whether cut. */
export type Report = Readonly<{
  label: string;
  items: readonly DeviceItem[];
  truncated: boolean;
}>;

function weight(report: Report): number {
  return new TextEncoder().encode(JSON.stringify(report)).length;
}

/** A port's answer, rebuilt and cut to what one frame may carry. */
export function reportOf(result: SessionResult): Report {
  const lines = result.items.flatMap((item) => {
    const line = lineOf(item);
    return line ? [line] : [];
  });
  const label = clean(result.label, LABEL_MAX);
  let report: Report = {
    label: label === "" ? "Result" : label,
    items: lines.slice(0, ITEMS_MAX),
    truncated: lines.length > ITEMS_MAX || lines.length < result.items.length,
  };
  // Halve until it fits, so a long answer costs lines, never the whole call.
  while (weight(report) > RESULT_BYTES && report.items.length > 0)
    report = {
      ...report,
      items: report.items.slice(0, Math.floor(report.items.length / 2)),
      truncated: true,
    };
  return report;
}

export type Called =
  | Readonly<{ ok: true; report: Report }>
  | Readonly<{ ok: false; error: DeviceErrorCode }>;

/**
 * Make the call. `ended` is aborted when the grant or the session ends; the
 * call's own signal also carries the time limit. An answer that cannot be
 * rebuilt (a port that returned something that is not one) is a failure of
 * the upstream, not of the device.
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
    return { ok: true, report: reportOf(result) };
  } catch (error) {
    if (signal.aborted) return { ok: false, error: "temporarily_unavailable" };
    return {
      ok: false,
      error:
        error instanceof InvalidCall ? "invalid_request" : "upstream_error",
    };
  } finally {
    clearTimeout(timer);
  }
}
