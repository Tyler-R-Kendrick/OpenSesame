import type { JsonObject } from "./json.js";

export type DomainErrorCode =
  | "INVALID_TRANSITION"
  | "EXPIRED"
  | "INVALID_TOKEN"
  | "INVALID_USER_CODE"
  | "CONFLICT"
  | "INVARIANT_VIOLATION"
  | "NOT_FOUND"
  | "DEPENDENCY_CLOSURE"
  | "IMMUTABLE_FIELD";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: JsonObject;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: JsonObject = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function invalidTransition(
  from: string,
  to: string,
  machine: string,
): DomainError {
  return new DomainError(
    "INVALID_TRANSITION",
    `Invalid ${machine} transition: ${from} -> ${to}`,
    { from, to, machine },
  );
}
