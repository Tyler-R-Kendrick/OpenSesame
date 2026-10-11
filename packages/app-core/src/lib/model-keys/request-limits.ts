/**
 * What the authority will send (ADR 0192 §6).
 *
 * `executeNativeApiRequest` refuses a body it does not trust before any request
 * leaves: an array over 100 items, a string over 65536 characters, an object
 * over 100 keys or a key over 4096, nesting past ten levels. A call it would
 * refuse there must be refused here, before a budget is reserved for it, so
 * these are its limits. `gateway.refund.test.ts` holds each one against the
 * real executor.
 */
import { type JsonValue, isJsonObject, isString } from "@opensesame/os-domain";
import { refuse } from "./errors.js";

export const SEND_LIMITS = {
  depth: 10,
  items: 100,
  keys: 100,
  keyLength: 4096,
  stringLength: 65_536,
} as const;

function walk(value: JsonValue | undefined, depth: number): void {
  if (depth > SEND_LIMITS.depth) refuse("invalid_request", "body.limits");
  if (isString(value)) {
    if (value.length > SEND_LIMITS.stringLength)
      refuse("invalid_request", "body.limits");
  } else if (Array.isArray(value)) {
    if (value.length > SEND_LIMITS.items)
      refuse("invalid_request", "body.limits");
    for (const item of value) walk(item, depth + 1);
  } else if (isJsonObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > SEND_LIMITS.keys)
      refuse("invalid_request", "body.limits");
    for (const [key, item] of entries) {
      if (key.length > SEND_LIMITS.keyLength)
        refuse("invalid_request", "body.limits");
      walk(item, depth + 1);
    }
  }
}

/** Refuse a body the authority would refuse; the body must already be plain JSON. */
export function withinSendLimits(body: JsonValue): void {
  walk(body, 0);
}
