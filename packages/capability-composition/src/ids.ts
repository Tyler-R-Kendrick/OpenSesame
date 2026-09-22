/**
 * Branded identifier types for operator-controlled capability composition.
 *
 * Every id is a string at runtime; the brands keep distinct identifier
 * families from being passed to each other's consumers. There is no implicit
 * coercion: an unbranded string never satisfies a branded id, and validators
 * are the only road in.
 */
import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";

/** Brand marker; structural type only, never instantiated at runtime. */
declare const brand: unique symbol;

/** A capability id ("vault.write" style dotted path). */
export type CapabilityId = string & { readonly [brand]: "CapabilityId" };
/** An operation id within a capability. */
export type OperationId = string & { readonly [brand]: "OperationId" };
/** A module id (an importable unit of the build graph). */
export type ModuleId = string & { readonly [brand]: "ModuleId" };
/** An asset id (versioned artifacts of a distribution). */
export type AssetId = string & { readonly [brand]: "AssetId" };

/** Capability ids are non-empty dotted paths, 1..200 chars, ASCIIish. */
const CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/;

/** Narrow an untrusted value to a CapabilityId, or `undefined`. */
export function capabilityId(value: BoundaryValue): CapabilityId | undefined {
  return isString(value) && CAPABILITY_ID_PATTERN.test(value)
    ? overlapCast(value)
    : undefined;
}

/** Narrow an untrusted value to an OperationId, or `undefined`. */
export function operationId(value: BoundaryValue): OperationId | undefined {
  return isString(value) && CAPABILITY_ID_PATTERN.test(value)
    ? overlapCast(value)
    : undefined;
}

/** Narrow an untrusted value to a ModuleId, or `undefined`. */
export function moduleId(value: BoundaryValue): ModuleId | undefined {
  return isString(value) && CAPABILITY_ID_PATTERN.test(value)
    ? overlapCast(value)
    : undefined;
}

/** Narrow an untrusted value to an AssetId, or `undefined`. */
export function assetId(value: BoundaryValue): AssetId | undefined {
  return isString(value) && CAPABILITY_ID_PATTERN.test(value)
    ? overlapCast(value)
    : undefined;
}

/**
 * Every reason code the resolver may attach to a capability, module or plan.
 * The union is closed; new diagnoses require extending this list and the
 * explanations in `explain.ts` together.
 */
export const REASON_CODES = [
  "NOT_DISTRIBUTED",
  "PROHIBITED_BY_INSTANCE",
  "DENIED_BY_WORKSPACE",
  "NOT_SELECTED",
  "CONSENT_REQUIRED",
  "DEPENDENCY_CONFLICT",
  "UNSUPPORTED_RUNTIME",
  "POLICY_UNVERIFIED",
  "PROFILE_MISMATCH",
  "NOT_CACHED_OFFLINE",
  "RESTART_REQUIRED",
  "UNKNOWN",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** True only for one of the closed reason-code strings. */
export function isReasonCode(value: BoundaryValue): value is ReasonCode {
  return (
    isString(value) &&
    REASON_CODES.some((code: ReasonCode) => code === value)
  );
}

/** Every policy/document kind the composition layer understands. */
export const DOCUMENT_KINDS = [
  "instance-policy",
  "vault-restriction",
  "installation-selection",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** True only for one of the closed document-kind strings. */
export function isDocumentKind(value: BoundaryValue): value is DocumentKind {
  return (
    isString(value) &&
    DOCUMENT_KINDS.some((kind: DocumentKind) => kind === value)
  );
}
