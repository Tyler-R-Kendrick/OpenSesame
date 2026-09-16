import { walletError } from "./errors.js";

/**
 * Wire-safe monetary units: a canonical non-negative integer as a decimal
 * digit string. Never a JS `Number`. Fractional display amounts are converted
 * through a trusted asset exponent into these units.
 */
export type AmountUnits = string;

/** In-memory exact units for checked arithmetic. */
export type AmountUnitsExact = bigint;

/**
 * Largest exact units admitted (2^256 − 1). Matches typical token ceilings and
 * keeps JSON/WASM/Rust fixtures aligned without saturating silently.
 */
export const MAX_AMOUNT_UNITS_EXACT = (1n << 256n) - 1n;

/** Longest accepted integer-digit string (covers 2^256 − 1 in decimal). */
export const MAX_AMOUNT_DIGIT_CHARS = 78;

const ASCII_DIGITS = /^[0-9]+$/;
const LEADING_ZERO_INTEGER = /^0[0-9]/;

/**
 * Asset scale used when parsing a human decimal into units.
 * Fiat `exponent` and token `decimals` share this bound.
 */
export const MAX_ASSET_EXPONENT = 18;

function assertAssetScale(raw: number, label: string): number {
  if (!Number.isInteger(raw) || raw < 0 || raw > MAX_ASSET_EXPONENT) {
    throw walletError(
      "AMOUNT_INVALID",
      `${label} must be an integer 0..${MAX_ASSET_EXPONENT}`,
      { details: { scale: raw } },
    );
  }
  return raw;
}

export function amountExponent(
  asset:
    | {
        readonly kind: "fiat";
        readonly exponent: number;
      }
    | {
        readonly kind: "token";
        readonly decimals: number;
      },
): number {
  return asset.kind === "fiat"
    ? assertAssetScale(asset.exponent, "fiat exponent")
    : assertAssetScale(asset.decimals, "token decimals");
}

function rejectAmount(
  code: "AMOUNT_INVALID" | "AMOUNT_OVERFLOW" | "AMOUNT_PRECISION_EXCEEDED",
  message: string,
): never {
  throw walletError(code, message);
}

/** True when `value` is a canonical AmountUnits digit string. */
export function isAmountUnits(value: string): boolean {
  if (value.length === 0 || value.length > MAX_AMOUNT_DIGIT_CHARS) return false;
  if (!ASCII_DIGITS.test(value)) return false;
  if (LEADING_ZERO_INTEGER.test(value)) return false;
  return true;
}

export function assertAmountUnits(value: string): AmountUnits {
  if (!isAmountUnits(value)) {
    rejectAmount(
      "AMOUNT_INVALID",
      "AmountUnits must be a canonical non-negative integer digit string",
    );
  }
  const exact = BigInt(value);
  if (exact > MAX_AMOUNT_UNITS_EXACT) {
    rejectAmount("AMOUNT_OVERFLOW", "AmountUnits exceeds the 256-bit domain");
  }
  return value;
}

export function toAmountExact(units: AmountUnits): AmountUnitsExact {
  const canonical = assertAmountUnits(units);
  return BigInt(canonical);
}

export function fromAmountExact(exact: AmountUnitsExact): AmountUnits {
  if (exact < 0n) {
    rejectAmount("AMOUNT_INVALID", "AmountUnitsExact must be non-negative");
  }
  if (exact > MAX_AMOUNT_UNITS_EXACT) {
    rejectAmount(
      "AMOUNT_OVERFLOW",
      "AmountUnitsExact exceeds the 256-bit domain",
    );
  }
  return exact.toString(10);
}

/**
 * Parse a human decimal display string into exact units.
 *
 * Rejects NaN tokens, signs, exponent notation, Unicode numerals, grouping
 * separators, and fractional digits beyond the asset scale.
 */
export function parseDecimalToUnits(
  display: string,
  exponent: number,
): AmountUnits {
  if (
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > MAX_ASSET_EXPONENT
  ) {
    rejectAmount(
      "AMOUNT_INVALID",
      `exponent must be an integer 0..${MAX_ASSET_EXPONENT}`,
    );
  }
  if (display.length === 0) {
    rejectAmount("AMOUNT_INVALID", "decimal amount must be a non-empty string");
  }
  if (
    /[eE+\-_]/.test(display) ||
    display.includes("Infinity") ||
    display === "NaN"
  ) {
    rejectAmount(
      "AMOUNT_INVALID",
      "decimal amount must not use signs, exponent notation, or NaN/Infinity",
    );
  }
  for (let i = 0; i < display.length; i += 1) {
    const code = display.charCodeAt(i);
    const isDigit = code >= 0x30 && code <= 0x39;
    const isDot = code === 0x2e;
    if (!isDigit && !isDot) {
      rejectAmount(
        "AMOUNT_INVALID",
        "decimal amount may only contain ASCII digits and a single '.'",
      );
    }
  }
  const parts = display.split(".");
  if (parts.length > 2) {
    rejectAmount(
      "AMOUNT_INVALID",
      "decimal amount may contain at most one '.'",
    );
  }
  const wholeRaw = parts[0] ?? "";
  const fracRaw = parts[1];
  if (wholeRaw.length === 0) {
    rejectAmount("AMOUNT_INVALID", "decimal amount needs an integer part");
  }
  if (LEADING_ZERO_INTEGER.test(wholeRaw) && wholeRaw !== "0") {
    rejectAmount(
      "AMOUNT_INVALID",
      "decimal integer part must not have leading zeros",
    );
  }
  if (!ASCII_DIGITS.test(wholeRaw)) {
    rejectAmount("AMOUNT_INVALID", "decimal integer part must be ASCII digits");
  }
  if (fracRaw !== undefined) {
    if (!ASCII_DIGITS.test(fracRaw)) {
      rejectAmount(
        "AMOUNT_INVALID",
        "decimal fractional part must be ASCII digits",
      );
    }
    if (fracRaw.length > exponent) {
      rejectAmount(
        "AMOUNT_PRECISION_EXCEEDED",
        `fractional digits exceed asset exponent ${exponent}`,
      );
    }
  }
  const frac = (fracRaw ?? "").padEnd(exponent, "0");
  const combined = exponent === 0 ? wholeRaw : `${wholeRaw}${frac}`;
  const normalized =
    combined.replace(/^0+(?=\d)/, "") === ""
      ? "0"
      : combined.replace(/^0+(?=\d)/, "");
  return fromAmountExact(BigInt(normalized === "" ? "0" : normalized));
}

/** Format exact units back to a fixed-scale decimal display string. */
export function formatUnitsToDecimal(
  units: AmountUnits,
  exponent: number,
): string {
  if (
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > MAX_ASSET_EXPONENT
  ) {
    rejectAmount(
      "AMOUNT_INVALID",
      `exponent must be an integer 0..${MAX_ASSET_EXPONENT}`,
    );
  }
  const exact = toAmountExact(units);
  if (exponent === 0) return exact.toString(10);
  const digits = exact.toString(10).padStart(exponent + 1, "0");
  const cut = digits.length - exponent;
  const whole = digits.slice(0, cut);
  const frac = digits.slice(cut);
  return `${whole}.${frac}`;
}

export function compareAmountUnits(a: AmountUnits, b: AmountUnits): -1 | 0 | 1 {
  const left = toAmountExact(a);
  const right = toAmountExact(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function addAmountUnits(a: AmountUnits, b: AmountUnits): AmountUnits {
  const sum = toAmountExact(a) + toAmountExact(b);
  if (sum > MAX_AMOUNT_UNITS_EXACT) {
    rejectAmount("AMOUNT_OVERFLOW", "checked add exceeded the 256-bit domain");
  }
  return fromAmountExact(sum);
}

export function subAmountUnits(a: AmountUnits, b: AmountUnits): AmountUnits {
  const left = toAmountExact(a);
  const right = toAmountExact(b);
  if (right > left) {
    rejectAmount("AMOUNT_INVALID", "checked sub would go negative");
  }
  return fromAmountExact(left - right);
}

/**
 * Conserved redistribution: children may only partition `parent` capacity.
 * Their sum must equal `parent` exactly (exclusive carve) or be ≤ parent when
 * `mode` is `at_most`.
 */
export function assertRedistributedCapacity(
  parent: AmountUnits,
  children: readonly AmountUnits[],
  mode: "exact" | "at_most" = "exact",
): void {
  let total = 0n;
  for (const child of children) {
    total += toAmountExact(child);
    if (total > MAX_AMOUNT_UNITS_EXACT) {
      rejectAmount("AMOUNT_OVERFLOW", "child allocation sum overflowed");
    }
  }
  const ceiling = toAmountExact(parent);
  if (mode === "exact" && total !== ceiling) {
    throw walletError(
      "BUDGET_OPERATION_NOT_AUTHORIZED",
      "child allocations must redistribute parent capacity exactly",
      { details: { parent, childSum: fromAmountExact(total) } },
    );
  }
  if (mode === "at_most" && total > ceiling) {
    throw walletError(
      "INSUFFICIENT_CAPACITY",
      "child allocations exceed parent capacity",
      { details: { parent, childSum: fromAmountExact(total) } },
    );
  }
}
