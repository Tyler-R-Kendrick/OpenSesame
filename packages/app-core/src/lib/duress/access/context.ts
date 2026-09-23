/**
 * Opaque verified access context for duress-aware sessions (INV-04, INV-09, AUTH-A).
 * Not constructible from JSON public fields — only via issueAccessContext.
 * Deserialized / structured-clone copies are never authoritative (AT-032).
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";

export type PresentationClass =
  | "normal"
  | "restricted"
  | "decoy"
  | "locked"
  | "unchanged";

export type AccessContextClaims = Readonly<{
  principalRef: string;
  tenantRef: string | null;
  vaultRef: string;
  compartmentRefs: readonly string[];
  deviceBindingRef: string;
  presentation: PresentationClass;
  authorizationCeiling: readonly string[];
  denyOperations: readonly string[];
  policyRevision: number;
  incidentEpoch: number;
  keyEpoch: number;
  sessionGeneration: number;
  profileId: string | null;
  evidenceDigest: string;
}>;

const CONTEXT_BRAND = Symbol("DuressAccessContext");

export type AccessContext = {
  readonly [CONTEXT_BRAND]: true;
  readonly claims: AccessContextClaims;
};

/** Live verifier-issued handles only — never survives structured clone / JSON. */
const issued = new WeakSet<object>();

export function issueAccessContext(claims: AccessContextClaims): AccessContext {
  const ctx: AccessContext = {
    [CONTEXT_BRAND]: true,
    claims: Object.freeze({
      ...claims,
      compartmentRefs: Object.freeze([...claims.compartmentRefs]),
      authorizationCeiling: Object.freeze([...claims.authorizationCeiling]),
      denyOperations: Object.freeze([...claims.denyOperations]),
    }),
  };
  Object.freeze(ctx);
  issued.add(ctx);
  return ctx;
}

/** Public metadata only — copying this MUST NOT authenticate (AT-032, AUTH-F). */
export type PublicAccessMetadata = Readonly<{
  presentation: PresentationClass;
  policyRevision: number;
  incidentEpoch: number;
  sessionGeneration: number;
  profileId: string | null;
}>;

export type WireAccessContextLike = PublicAccessMetadata &
  Readonly<{ claims?: AccessContextClaims }>;

export type AccessContextProbe =
  | BoundaryValue
  | AccessContext
  | WireAccessContextLike;

export function isAccessContext(
  value: AccessContextProbe,
): value is AccessContext {
  if (value === null || value === undefined) return false;
  if (Object(value) !== value) return false;
  const objectValue = overlapCast<AccessContextProbe, object>(value);
  return CONTEXT_BRAND in objectValue && issued.has(objectValue);
}

export function publicAccessMetadata(ctx: AccessContext): PublicAccessMetadata {
  if (!isAccessContext(ctx)) {
    throw new Error("stale_session: forged or deserialized access context");
  }
  return {
    presentation: ctx.claims.presentation,
    policyRevision: ctx.claims.policyRevision,
    incidentEpoch: ctx.claims.incidentEpoch,
    sessionGeneration: ctx.claims.sessionGeneration,
    profileId: ctx.claims.profileId,
  };
}

function isPresentationClass(
  value: BoundaryValue | undefined,
): value is PresentationClass {
  return (
    value === "normal" ||
    value === "restricted" ||
    value === "decoy" ||
    value === "locked" ||
    value === "unchanged"
  );
}

/**
 * Parse wire/public metadata. Never yields an AccessContext — callers must
 * re-verify through the issuer (AUTH-A / AT-032).
 */
export function parsePublicAccessMetadata(
  raw: BoundaryValue,
): PublicAccessMetadata | null {
  if (!isJsonObject(raw)) return null;
  const row = raw;
  const presentation = row.presentation;
  if (!isPresentationClass(presentation)) {
    return null;
  }
  const policyRevision = row.policyRevision;
  const incidentEpoch = row.incidentEpoch;
  const sessionGeneration = row.sessionGeneration;
  if (
    !isNumber(policyRevision) ||
    !isNumber(incidentEpoch) ||
    !isNumber(sessionGeneration)
  ) {
    return null;
  }
  const profileIdRaw = row.profileId;
  const profileId =
    profileIdRaw === null || isString(profileIdRaw) ? profileIdRaw : null;
  return {
    presentation,
    policyRevision,
    incidentEpoch,
    sessionGeneration,
    profileId,
  };
}

export type EpochExpectation = Readonly<{
  incidentEpoch?: number;
  policyRevision?: number;
  keyEpoch?: number;
  sessionGeneration?: number;
}>;

function assertEpochMatches(
  ctx: AccessContext,
  expected: EpochExpectation,
): void {
  const { claims } = ctx;
  if (
    expected.policyRevision !== undefined &&
    claims.policyRevision !== expected.policyRevision
  ) {
    throw new Error("stale_session: policy revision mismatch");
  }
  if (
    expected.incidentEpoch !== undefined &&
    claims.incidentEpoch !== expected.incidentEpoch
  ) {
    throw new Error("stale_session: incident epoch mismatch");
  }
  if (
    expected.keyEpoch !== undefined &&
    claims.keyEpoch !== expected.keyEpoch
  ) {
    throw new Error("stale_session: key epoch mismatch");
  }
  if (
    expected.sessionGeneration !== undefined &&
    claims.sessionGeneration !== expected.sessionGeneration
  ) {
    throw new Error("stale_session: session generation mismatch");
  }
}

/**
 * Authorize an operation against a live AccessContext handle.
 * Refuses forged/deserialized copies and enforces deny + ceiling (AUTH-A/D).
 */
export function assertContextAllows(
  ctx: AccessContext,
  operation: string,
  expected: EpochExpectation,
): void {
  if (!isAccessContext(ctx)) {
    throw new Error("stale_session: forged or deserialized access context");
  }
  assertEpochMatches(ctx, expected);
  if (ctx.claims.denyOperations.includes(operation)) {
    throw new Error(`denied_by_incident: ${operation}`);
  }
  const ceiling = ctx.claims.authorizationCeiling;
  if (ceiling.length > 0 && !ceiling.includes(operation)) {
    throw new Error(`ceiling_denied: ${operation}`);
  }
}

export function intersectDenyCeilings(
  incidents: readonly { denyOperations: readonly string[] }[],
): string[] {
  const merged = new Set<string>();
  for (const row of incidents) {
    for (const op of row.denyOperations) merged.add(op);
  }
  return [...merged].sort();
}

/** Intersection of admitted compartment refs across concurrent incidents (AT-039). */
export function intersectCompartments(
  lists: readonly (readonly string[])[],
): string[] {
  if (lists.length === 0) return [];
  let next = new Set(lists[0]);
  for (let i = 1; i < lists.length; i += 1) {
    const row = new Set(lists[i]);
    next = new Set([...next].filter((ref) => row.has(ref)));
  }
  return [...next].sort();
}
