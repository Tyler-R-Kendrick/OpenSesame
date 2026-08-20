import { SENSITIVE_KEY_PATTERN } from "@opensesame/observability";
import { type JsonObject, overlapCast, type BoundaryValue, isNumber, isBoolean } from "@opensesame/os-domain";

/**
 * Events `track()` will ever forward to `capture`. Anything else — typos,
 * a caller improvising a new event name, an event from an unrelated system —
 * is silently dropped. Telemetry is additive-only: adding an event here is a
 * deliberate decision, not something a call site can do unilaterally.
 */
export const ALLOWED_EVENTS = [
  "app_opened",
  "vault_unlocked",
  "vault_unlock_failed",
  "vault_locked",
  "item_opened",
  "ceremony_queued",
  "ceremony_completed",
  "settings_changed",
  "mcp_tool_call",
] as const;

export type TelemetryEvent = (typeof ALLOWED_EVENTS)[number];

/**
 * Prop keys `track()` will ever forward to `capture`. Every other key on the
 * `props` object passed by a caller is silently dropped — this is the
 * allowlist, enforced here at the capture site, not just documented.
 */
export const ALLOWED_PROP_KEYS = [
  "tool",
  "client",
  "client_version",
  "duration_ms",
  "outcome",
  "error_class",
  "item_type",
  "queue_depth",
] as const;

export type TelemetryPropKey = (typeof ALLOWED_PROP_KEYS)[number];

/** Allowed string prop values are truncated (never rejected) at this length. */
const MAX_STRING_LENGTH = 64;

/**
 * Extra forbidden terms, checked as case-insensitive substrings against both
 * an allowed key's *name* and its (stringified) *value*.
 *
 * `SENSITIVE_KEY_PATTERN` from `@opensesame/observability` is reused below as
 * the primary defense-in-depth check, but it is anchored end-to-end
 * (`^token$`, `^client[_-]?secret$`, …) — it is built to recognize a sensitive
 * *key name*, not to find a sensitive term hiding inside an arbitrary
 * free-text *value* (e.g. `outcome: "Bearer sk-secret-abc"`, where nothing
 * about the key "outcome" is sensitive but the value smuggles a token). This
 * list exists for exactly that substring case, plus a couple of terms this
 * package cares about that the shared pattern doesn't carry (`email`, `sub`,
 * `prompt` — none of which are "sensitive log keys" in the observability
 * sense, but all of which are things that must never end up as free-text
 * telemetry).
 */
export const FORBIDDEN_SUBSTRINGS = [
  "token",
  "secret",
  "authorization",
  "cookie",
  "pepper",
  "key",
  "pin",
  "prompt",
  "email",
  "sub",
] as const;

/**
 * Table-test fixture: one row per forbidden term, each smuggled inside the
 * *value* of an otherwise-allowed prop key. This package's own suite (see
 * `__tests__/telemetry.test.ts`) asserts every row is dropped by `track()`;
 * any other package wiring telemetry can reuse this fixture the same way.
 */
export const redactionTest: ReadonlyArray<{
  label: string;
  key: TelemetryPropKey;
  value: string;
}> = [
  { label: "token", key: "outcome", value: "Bearer sk-token-abc123" },
  { label: "secret", key: "outcome", value: "client_secret=xyz" },
  { label: "authorization", key: "outcome", value: "authorization failed" },
  { label: "cookie", key: "error_class", value: "SetCookieLeakError" },
  { label: "pepper", key: "outcome", value: "user_code_pepper leaked" },
  { label: "key", key: "outcome", value: "api_key=abc123" },
  { label: "pin", key: "outcome", value: "pin=123456" },
  { label: "prompt", key: "outcome", value: "system prompt leaked" },
  { label: "email", key: "client", value: "contact-email@example.com" },
  { label: "sub", key: "client", value: "sub-claim-1234" },
];

function containsForbidden(text: string): boolean {
  const lower = text.toLowerCase();
  return FORBIDDEN_SUBSTRINGS.some((term) => lower.includes(term));
}

/**
 * A key name is refused if it matches the shared sensitive-key pattern
 * (exact, anchored match — e.g. a prop literally named `token`) or contains
 * one of this package's forbidden substrings (looser, catches compound names
 * like `client_email`). Neither should ever fire in practice, since only
 * `ALLOWED_PROP_KEYS` reach this check — it exists as defense-in-depth for
 * if that allowlist ever grows a key that shouldn't have been added.
 */
function isForbiddenKeyName(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || containsForbidden(key);
}

/**
 * Coerce an allowed prop's value to a telemetry-safe primitive: numbers and
 * booleans pass through unchanged, everything else becomes a string
 * truncated to `MAX_STRING_LENGTH` (never rejected for length — long values
 * are just clipped).
 */
function coercePrimitive(value: BoundaryValue): string | number | boolean {
  if (isNumber(value) || isBoolean(value)) return value;
  const str = String(value);
  return str.length > MAX_STRING_LENGTH ? str.slice(0, MAX_STRING_LENGTH) : str;
}

/**
 * Filters `props` down to the allowlisted keys, coerces each surviving value
 * to a primitive, then runs both the key name and the (untruncated, so a
 * forbidden term just past the truncation point is still caught) stringified
 * value through the forbidden-content check. A prop that trips either check
 * is dropped entirely — not redacted, not truncated further — so a caller
 * never sees a telemetry event with a half-scrubbed value that still hints at
 * what leaked.
 */
function sanitizeProps(
  props: JsonObject | undefined,
): JsonObject {
  const out: JsonObject = {};
  if (!props) return out;

  for (const [key, rawValue] of Object.entries(props)) {
    if (!(overlapCast(ALLOWED_PROP_KEYS)).includes(key)) continue;
    if (isForbiddenKeyName(key)) continue;

    // Checked pre-truncation: a forbidden term sitting just past the 64-char
    // cutoff must still be caught, not sliced away and waved through.
    if (containsForbidden(String(rawValue))) continue;

    out[key] = coercePrimitive(rawValue);
  }

  return out;
}

export interface Telemetry {
  track(event: string, props?: JsonObject): void;
}

export interface CreateTelemetryOptions {
  capture: (event: string, props: JsonObject) => void;
}

/**
 * Build a `track()` function that is a no-op unless `event` is one of
 * `ALLOWED_EVENTS` and, even then, forwards only the allowlisted, sanitized
 * subset of `props`. `capture` is the only place this ever reaches out
 * (network, disk, anything) — callers decide what `capture` does (including
 * doing nothing, e.g. when no telemetry key is configured), this function
 * only ever decides *what* is safe to hand it.
 */
export function createTelemetry({
  capture,
}: CreateTelemetryOptions): Telemetry {
  const allowedEvents: ReadonlySet<string> = new Set(ALLOWED_EVENTS);

  return {
    track(event, props) {
      if (!allowedEvents.has(event)) return;
      capture(event, sanitizeProps(props));
    },
  };
}
