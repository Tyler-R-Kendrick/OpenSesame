/** Inactive Pages-header lexical profile only. This establishes no authentication. */
import { type BoundaryValue, isString } from "@opensesame/os-domain";

const MAX_RAW_UNITS = 65536;
const MAX_SAFE = "9007199254740991";
function unavailable(): never {
  throw new Error("Retired credential context is unavailable.");
}
function afterString(raw: string, start: number): number {
  for (let i = start + 1; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '"') return i;
    if (ch === "\\") i++;
  }
  return unavailable();
}

/**
 * Run AFTER the bounded duplicate/Unicode/depth preflight, BEFORE JSON.parse.
 * Every numeric field in the strict Pages header profile is a nonnegative safe
 * integer. Strings are opaque here. This does not validate JSON grammar, UTF-8,
 * schema, MACs, factors or authority and must not be used for general JSON.
 */
export function assertPagesHeaderIntegerProfile(raw: BoundaryValue): void {
  if (!isString(raw) || raw.length > MAX_RAW_UNITS) unavailable();
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '"') {
      i = afterString(raw, i);
    } else if (/[0-9+-]/.test(ch)) {
      const start = i;
      while (i + 1 < raw.length && /[0-9eE.+-]/.test(raw.charAt(i + 1))) i++;
      const length = i - start + 1;
      if (length > MAX_SAFE.length) unavailable();
      const token = raw.slice(start, i + 1);
      if (
        !/^(?:0|[1-9][0-9]*)$/.test(token) ||
        (length === MAX_SAFE.length && token > MAX_SAFE)
      )
        unavailable();
    }
  }
}
