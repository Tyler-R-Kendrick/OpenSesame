import { type JsonObject, overlapCast, type BoundaryValue, isString, isTypeofObject } from "@opensesame/os-domain";
const SECRET_NEEDLES = [
  "password",
  "secret",
  "token",
  "authorization",
  "refresh_token",
  "access_token",
  "client_secret",
  "cookie",
];

export function assertNoSecretFields(
  value: BoundaryValue,
  redact: (v: BoundaryValue) => BoundaryValue,
): void {
  const redacted = redact(value);
  walk(redacted, (key, child) => {
    if (SECRET_NEEDLES.some((n) => key.toLowerCase().includes(n))) {
      if (
        isString(child) &&
        child !== "[REDACTED]" &&
        child.length > 0
      ) {
        throw new Error(`secret field ${key} survived redaction`);
      }
    }
  });
}

export function assertMalformedDenied(ok: boolean, reason: string): void {
  if (ok) {
    throw new Error(reason);
  }
}

function walk(
  value: BoundaryValue,
  visit: (key: string, child: BoundaryValue) => void,
): void {
  if (value && isTypeofObject(value)) {
    for (const [k, v] of Object.entries(overlapCast(value))) {
      visit(k, v);
      walk(v, visit);
    }
  }
}
