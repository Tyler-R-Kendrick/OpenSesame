/**
 * The scrubber (ADR 0150). It is compiled from `spec/log-scrub/log-scrub.json`,
 * the same file `crates/redaction` reads, so a secret is recognised the same
 * way on both planes and one vector table proves both.
 *
 * Two layers, because neither is enough alone. A *key* layer censors the value
 * of anything named like a secret (`accessToken`, `x-api-key`, `db_password`).
 * A *value* layer rewrites text that carries a secret with no key to name it:
 * a bearer inside an error message, a `#token=` in a URL, a JWT in a stack
 * trace, a DSN with a password in it. Scrubbing is idempotent and value-blind:
 * it never needs to know the secret, only what one looks like.
 */

import {
  type BoundaryObject,
  type BoundaryValue,
  type MutableBoundaryObject,
  isBoolean,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import spec from "../../../spec/log-scrub/log-scrub.json" with { type: "json" };

/** What replaces a secret. */
export const REDACTED: string = spec.marker;

/** Depth ceiling so a hostile or cyclic object cannot stall a logger. */
const MAX_DEPTH = 12;

interface CompiledRule {
  readonly re: RegExp;
  readonly replace: string;
}

const RULES: readonly CompiledRule[] = spec.rules.map((rule) => ({
  re: new RegExp(rule.pattern, `g${rule.flags}`),
  replace: rule.replace,
}));

const KEY_STRIP = new RegExp(spec.keys.strip, "g");
const KEY_EXACT: ReadonlySet<string> = new Set(spec.keys.exact);
const KEY_SUFFIXES: readonly string[] = spec.keys.suffixes;

/** `$1`..`$9` in a spec template are capture groups; the rest is literal. */
function expand(
  template: string,
  groups: readonly (string | undefined)[],
): string {
  return template.replace(/\$([1-9])/g, (_match, n: string) => {
    return groups[Number(n) - 1] ?? "";
  });
}

function applyRule(rule: CompiledRule, text: string): string {
  return text.replace(rule.re, (_match: string, ...rest: BoundaryValue[]) => {
    // The trailing two arguments are the match offset and the input string.
    const groups = rest
      .slice(0, -2)
      .map((group) => (isString(group) ? group : undefined));
    return expand(rule.replace, groups);
  });
}

/** Rewrite every secret a piece of text carries. Idempotent. */
export function scrubText(text: string): string {
  let out = text;
  for (const rule of RULES) out = applyRule(rule, out);
  return out;
}

/** Is a key named like a secret? `tokenType` is not; `accessToken` is. */
export function isSensitiveKey(key: string): boolean {
  const normal = key.toLowerCase().replace(KEY_STRIP, "");
  if (KEY_EXACT.has(normal)) return true;
  return KEY_SUFFIXES.some((suffix) => normal.endsWith(suffix));
}

type Container = BoundaryObject | BoundaryValue[] | Error;

function scrubError(
  error: Error,
  depth: number,
  seen: WeakSet<Container>,
): MutableBoundaryObject {
  const out: MutableBoundaryObject = {
    name: error.name,
    message: scrubText(error.message),
  };
  if (error.stack !== undefined) out.stack = scrubText(error.stack);
  const code: BoundaryValue = overlapCast(error).code;
  if (isString(code)) out.code = scrubText(code);
  if (error.cause !== undefined) {
    out.cause = walk(overlapCast(error.cause), depth + 1, seen);
  }
  return out;
}

function walk(
  value: BoundaryValue,
  depth: number,
  seen: WeakSet<Container>,
): BoundaryValue {
  if (isString(value)) return scrubText(value);
  if (value === null || !isTypeofObject(value)) return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return REDACTED;
  }
  if (value instanceof Date) return value;
  if (seen.has(overlapCast(value))) return "[Circular]";
  seen.add(overlapCast(value));

  if (value instanceof Error) return scrubError(value, depth, seen);
  if (Array.isArray(value)) {
    return value.map((item) => walk(overlapCast(item), depth + 1, seen));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: MutableBoundaryObject = {};
  for (const [key, item] of Object.entries(overlapCast(value))) {
    const inner: BoundaryValue = overlapCast(item);
    if (isSensitiveKey(key) && inner !== null && !isBoolean(inner)) {
      out[key] = REDACTED;
    } else {
      out[key] = walk(inner, depth + 1, seen);
    }
  }
  return out;
}

/**
 * A copy of `value` with every secret gone: sensitive keys censored at any
 * depth, every string scrubbed, errors flattened to scrubbed plain objects,
 * binary replaced, cycles and runaway depth cut. Class instances other than
 * errors pass through untouched — log a plain object, not a client.
 */
export function scrubValue<T>(value: T): T {
  const input: BoundaryValue = overlapCast(value);
  return overlapCast(walk(input, 0, new WeakSet<Container>()));
}
