import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import type { MandateClaims, MandateConstraints } from "./types.js";

function str(value: BoundaryValue): string | undefined {
  return isString(value) ? value : undefined;
}

function num(value: BoundaryValue): number | undefined {
  return isNumber(value) ? value : undefined;
}

function roleOf(value: BoundaryValue): "cart" | "payment" | undefined {
  if (value === "cart" || value === "payment") return value;
  return undefined;
}

function nonNegativeInt(value: string | undefined): value is string {
  return value !== undefined && /^[0-9]+$/u.test(value);
}

function parseConstraints(value: BoundaryValue): MandateConstraints | undefined {
  if (!isJsonObject(value)) return undefined;
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

function hasCrit(value: BoundaryValue): boolean {
  return (
    Array.isArray(value) &&
    value.includes("constraints") &&
    value.includes("protection")
  );
}

function asObject(payload: BoundaryValue): JsonObject | null {
  return isJsonObject(payload) ? payload : null;
}

export function asClaims(payload: BoundaryValue): MandateClaims | null {
  const record = asObject(payload);
  if (!record) return null;
  const iss = str(record.iss);
  const aud = str(record.aud);
  const sub = str(record.sub);
  const jti = str(record.jti);
  const iat = num(record.iat);
  const exp = num(record.exp);
  const role = roleOf(record.role);
  const cartHash = str(record.cartHash);
  const amount = str(record.amount);
  const constraints = parseConstraints(record.constraints);
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
    record.protection !== "required" ||
    !hasCrit(record.crit)
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
  payload: BoundaryValue,
): "protection_downgrade" | "constraint_stripped" | "critical_missing" {
  const record = asObject(payload);
  if (record) {
    if (record.protection === "optional" || record.protection === "none") {
      return "protection_downgrade";
    }
    if (record.constraints === undefined) return "constraint_stripped";
  }
  return "critical_missing";
}
