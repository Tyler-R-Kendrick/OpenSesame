/**
 * Detection-only canary wire schema (CANARY-B / CANARY-F).
 * Rejects destructive and production-authority injection at parse time.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { includesStringLiteral } from "../json-boundary.js";

/**
 * Optional ALERT-shaped receiver (mirrors contracts AlertSpec fields).
 * Structural type — CANARY imports ALERT contracts conceptually without editing ALERT paths.
 */
export type CanaryReceiver = Readonly<{
  routeRef: string;
  templateRef: string;
  maxRetries: number;
  expiryMs: number;
  retainOutboxAcrossRemoval: boolean;
}>;

/** Sole shipped canary type: honeytoken observation → detection, never authority. */
export type CanaryKind = "honeytoken_open";

export type CanaryEnrollment = Readonly<{
  version: 1;
  canaryId: string;
  kind: CanaryKind;
  /** Optional pre-enrolled alert receiver — detection works without it. */
  receiver: CanaryReceiver | null;
  /** Fingerprint of the honeytoken (not the raw secret). */
  tokenFingerprint: string;
  enrolledAt: string;
  /** When true, detection still records but alert route is unused. */
  routeRevoked: boolean;
}>;

export type CanaryActivation = Readonly<{
  version: 1;
  canaryId: string;
  kind: CanaryKind;
  tokenFingerprint: string;
  detectedAt: string;
}>;

/** Capability / destructive keys that must never appear on canary documents. */
export const CANARY_FORBIDDEN_KEYS = Object.freeze([
  "removal",
  "wipe",
  "delete",
  "destroy",
  "mintSession",
  "openRoot",
  "recover",
  "approve",
  "hold",
  "presentation",
  "quarantine",
  "quarantinePeerRefs",
  "providerRevocation",
  "providerRevocationRefs",
  "operationCeiling",
  "operationCeilingRef",
  "webhook",
  "webhookUrl",
  "arbitraryCode",
  "script",
  "eval",
  "productionAuthority",
  "sessionToken",
  "rootKey",
] as const);

export type CanaryForbiddenKey = (typeof CANARY_FORBIDDEN_KEYS)[number];

export const CANARY_BOUNDS = Object.freeze({
  canaryIdMin: 2,
  canaryIdMax: 128,
  fingerprintMin: 16,
  fingerprintMax: 128,
  /** Dedup window for identical canary hits. */
  dedupWindowMs: 60_000,
  /** Soft false-positive bound: hits in this window before suppressing alerts. */
  falsePositiveWindowMs: 3_600_000,
  /** Max non-deduped hits per false-positive window before alert suppression. */
  falsePositiveMaxHits: 8,
  routeRefMax: 128,
  templateRefMax: 128,
  maxRetriesMax: 32,
  expiryMsMax: 1000 * 60 * 60 * 24 * 365,
} as const);

export class CanarySchemaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CanarySchemaError";
    this.code = code;
  }
}

export function assertNoForbiddenCanaryKeys(
  obj: JsonObject,
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (includesStringLiteral(CANARY_FORBIDDEN_KEYS, key)) {
      throw new CanarySchemaError(
        "contradictory_actions",
        `${path}: canary cannot carry destructive or authority field '${key}'`,
      );
    }
    const val = obj[key];
    if (isJsonObject(val)) {
      assertNoForbiddenCanaryKeys(val, `${path}.${key}`);
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i += 1) {
        const item = val[i];
        if (isJsonObject(item)) {
          assertNoForbiddenCanaryKeys(item, `${path}.${key}[${i}]`);
        }
      }
    }
  }
}

function requireString(
  obj: JsonObject,
  key: string,
  min: number,
  max: number,
): string {
  const v = obj[key];
  if (!isString(v) || v.length < min || v.length > max) {
    throw new CanarySchemaError("scope_mismatch", `invalid ${key}`);
  }
  return v;
}

function parseReceiver(raw: BoundaryValue | undefined): CanaryReceiver | null {
  if (raw === null || raw === undefined) return null;
  if (!isJsonObject(raw)) {
    throw new CanarySchemaError(
      "unapproved_route",
      "receiver must be object or null",
    );
  }
  const obj = raw;
  assertNoForbiddenCanaryKeys(obj, "receiver");
  const routeRef = requireString(obj, "routeRef", 1, CANARY_BOUNDS.routeRefMax);
  const templateRef = requireString(
    obj,
    "templateRef",
    1,
    CANARY_BOUNDS.templateRefMax,
  );
  const maxRetries = obj.maxRetries;
  const expiryMs = obj.expiryMs;
  const retain = obj.retainOutboxAcrossRemoval;
  if (
    !isNumber(maxRetries) ||
    !Number.isInteger(maxRetries) ||
    maxRetries < 0
  ) {
    throw new CanarySchemaError("unsupported_factor", "invalid maxRetries");
  }
  if (maxRetries > CANARY_BOUNDS.maxRetriesMax) {
    throw new CanarySchemaError(
      "unsupported_factor",
      "maxRetries out of bounds",
    );
  }
  if (!isNumber(expiryMs) || !Number.isInteger(expiryMs) || expiryMs <= 0) {
    throw new CanarySchemaError("unsupported_factor", "invalid expiryMs");
  }
  if (expiryMs > CANARY_BOUNDS.expiryMsMax) {
    throw new CanarySchemaError("unsupported_factor", "expiryMs out of bounds");
  }
  if (!isBoolean(retain)) {
    throw new CanarySchemaError(
      "unsupported_factor",
      "retainOutboxAcrossRemoval required",
    );
  }
  return {
    routeRef,
    templateRef,
    maxRetries,
    expiryMs,
    retainOutboxAcrossRemoval: retain,
  };
}

/**
 * Parse enrollment for the honeytoken_open canary type.
 * Fails closed on destructive injection or unknown kinds.
 */
export function parseCanaryEnrollment(input: BoundaryValue): CanaryEnrollment {
  if (!isJsonObject(input)) {
    throw new CanarySchemaError(
      "unsupported_profile_version",
      "enrollment must be object",
    );
  }
  const obj = input;
  assertNoForbiddenCanaryKeys(obj, "enrollment");
  if (obj.version !== 1) {
    throw new CanarySchemaError(
      "unsupported_profile_version",
      "unsupported canary version",
    );
  }
  if (obj.kind !== "honeytoken_open") {
    throw new CanarySchemaError(
      "unsupported_factor",
      "unsupported canary kind",
    );
  }
  const canaryId = requireString(
    obj,
    "canaryId",
    CANARY_BOUNDS.canaryIdMin,
    CANARY_BOUNDS.canaryIdMax,
  );
  const tokenFingerprint = requireString(
    obj,
    "tokenFingerprint",
    CANARY_BOUNDS.fingerprintMin,
    CANARY_BOUNDS.fingerprintMax,
  );
  const enrolledAtRaw = obj.enrolledAt;
  const enrolledAt =
    isString(enrolledAtRaw) && enrolledAtRaw.length > 0
      ? enrolledAtRaw
      : new Date().toISOString();
  const routeRevoked = obj.routeRevoked === true;
  return {
    version: 1,
    canaryId,
    kind: "honeytoken_open",
    receiver: parseReceiver(obj.receiver),
    tokenFingerprint,
    enrolledAt,
    routeRevoked,
  };
}

function resolveActivationFingerprint(obj: JsonObject): string {
  const tokenFingerprint = obj.tokenFingerprint;
  if (isString(tokenFingerprint)) return tokenFingerprint;
  const routeRef = obj.routeRef;
  if (isString(routeRef)) return `legacy-route:${routeRef}`;
  return "";
}

function assertActivationFingerprintBounds(tokenFingerprint: string): void {
  if (tokenFingerprint.length === 0) return;
  const withinBounds =
    tokenFingerprint.length >= CANARY_BOUNDS.fingerprintMin &&
    tokenFingerprint.length <= CANARY_BOUNDS.fingerprintMax;
  if (withinBounds) return;
  if (!tokenFingerprint.startsWith("legacy-route:")) {
    throw new CanarySchemaError("scope_mismatch", "invalid tokenFingerprint");
  }
  if (tokenFingerprint.length > CANARY_BOUNDS.fingerprintMax) {
    throw new CanarySchemaError("scope_mismatch", "tokenFingerprint too long");
  }
}

function parseActivationCanaryId(obj: JsonObject): string {
  const canaryId = obj.canaryId;
  if (!isString(canaryId) || canaryId.length < 1) {
    throw new CanarySchemaError("scope_mismatch", "canaryId required");
  }
  if (canaryId.length > CANARY_BOUNDS.canaryIdMax) {
    throw new CanarySchemaError("scope_mismatch", "canaryId too long");
  }
  return canaryId;
}

/**
 * Parse a detection activation payload. Rejects destructive injection.
 * Legacy shape `{ version, canaryId, routeRef, detectedAt }` is accepted and
 * mapped to honeytoken_open with empty fingerprint deferred to executor match.
 */
export function parseCanaryActivation(input: BoundaryValue): CanaryActivation {
  if (!isJsonObject(input)) {
    throw new CanarySchemaError(
      "unsupported_profile_version",
      "activation must be object",
    );
  }
  const obj = input;
  assertNoForbiddenCanaryKeys(obj, "activation");
  if (obj.version !== 1) {
    throw new CanarySchemaError(
      "unsupported_profile_version",
      "unsupported canary version",
    );
  }
  const canaryId = parseActivationCanaryId(obj);
  if (obj.kind !== undefined && obj.kind !== "honeytoken_open") {
    throw new CanarySchemaError(
      "unsupported_factor",
      "unsupported canary kind",
    );
  }
  const tokenFingerprint = resolveActivationFingerprint(obj);
  assertActivationFingerprintBounds(tokenFingerprint);

  const detectedAtRaw = obj.detectedAt;
  return {
    version: 1,
    canaryId,
    kind: "honeytoken_open",
    tokenFingerprint,
    detectedAt:
      isString(detectedAtRaw) && detectedAtRaw.length > 0
        ? detectedAtRaw
        : new Date().toISOString(),
  };
}
