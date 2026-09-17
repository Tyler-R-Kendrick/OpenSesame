import type { MandateClaims, MandateConstraints } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function roleOf(value: unknown): "cart" | "payment" | undefined {
  if (value === "cart" || value === "payment") return value;
  return undefined;
}

function nonNegativeInt(value: string | undefined): value is string {
  return value !== undefined && /^[0-9]+$/u.test(value);
}

function parseConstraints(value: unknown): MandateConstraints | undefined {
  if (!isRecord(value)) return undefined;
  const maxAmount = str(value.maxAmount);
  const currency = str(value.currency);
  const recipient = str(value.recipient);
  const assetFingerprint = str(value.assetFingerprint);
  if (
    !nonNegativeInt(maxAmount) ||
    currency === undefined ||
    recipient === undefined ||
    assetFingerprint === undefined ||
    value.protection !== "required" ||
    value.recurrence !== false
  ) {
    return undefined;
  }
  return {
    maxAmount,
    currency,
    recipient,
    assetFingerprint,
    protection: "required",
    recurrence: false,
  };
}

function hasCrit(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.includes("constraints") &&
    value.includes("protection")
  );
}

export function asClaims(payload: unknown): MandateClaims | null {
  if (!isRecord(payload)) return null;
  const iss = str(payload.iss);
  const aud = str(payload.aud);
  const sub = str(payload.sub);
  const jti = str(payload.jti);
  const iat = num(payload.iat);
  const exp = num(payload.exp);
  const role = roleOf(payload.role);
  const cartHash = str(payload.cartHash);
  const amount = str(payload.amount);
  const constraints = parseConstraints(payload.constraints);
  if (
    iss === undefined ||
    aud === undefined ||
    sub === undefined ||
    jti === undefined ||
    iat === undefined ||
    exp === undefined ||
    role === undefined ||
    cartHash === undefined ||
    !nonNegativeInt(amount) ||
    constraints === undefined ||
    payload.protection !== "required" ||
    !hasCrit(payload.crit)
  ) {
    return null;
  }
  return {
    iss,
    aud,
    sub,
    jti,
    iat,
    exp,
    role,
    cartHash,
    amount,
    protection: "required",
    crit: ["constraints", "protection"],
    constraints,
  };
}

export function malformedReason(
  payload: unknown,
): "protection_downgrade" | "constraint_stripped" | "critical_missing" {
  if (isRecord(payload)) {
    if (payload.protection === "optional" || payload.protection === "none") {
      return "protection_downgrade";
    }
    if (payload.constraints === undefined) return "constraint_stripped";
  }
  return "critical_missing";
}
