/**
 * Detection-only canary artifacts (CANARY). No session/key admission.
 * Public surface: schema + registry + executor, with thin legacy helpers.
 */

export {
  CANARY_BOUNDS,
  CANARY_FORBIDDEN_KEYS,
  CanarySchemaError,
  parseCanaryActivation,
  parseCanaryEnrollment,
  type CanaryActivation,
  type CanaryEnrollment,
  type CanaryForbiddenKey,
  type CanaryKind,
  type CanaryReceiver,
} from "./schema.js";

export { CanaryRegistry, type CanaryRegistrySnapshot } from "./registry.js";

export {
  executeCanaryDetection,
  recordCanaryHit,
  refuseDestructiveCanaryAction,
  resetCanaryExecutorState,
  type CanaryExecuteOutcome,
  type CanaryResult,
} from "./execute.js";

import {
  type BoundaryValue,
  type JsonObject,
  includesStringLiteral,
  isJsonObject,
  isString,
  overlapCast,
} from "../json-boundary.js";
import {
  type CanaryResult,
  recordCanaryHit as recordHit,
  resetCanaryExecutorState,
} from "./execute.js";
import { CanaryRegistry } from "./registry.js";
import {
  CANARY_FORBIDDEN_KEYS,
  parseCanaryActivation as parseActivation,
} from "./schema.js";
import type { CanaryEnrollment } from "./schema.js";

/** Legacy event shape used by early call sites / duress.test. */
export type CanaryEvent = Readonly<{
  version: 1;
  canaryId: string;
  routeRef: string;
  detectedAt: string;
}>;

export type CanaryCapability =
  | "detect"
  | "notify_enrolled_route"
  | "dedup"
  | "revoke_route";

export const CANARY_CAPABILITY_CEILING: readonly CanaryCapability[] = [
  "detect",
  "notify_enrolled_route",
  "dedup",
  "revoke_route",
] as const;

const revokedRoutes = new Set<string>();
const defaultRegistry = new CanaryRegistry();

function hasForbiddenKey(obj: JsonObject): boolean {
  for (const key of Object.keys(obj)) {
    if (includesStringLiteral(CANARY_FORBIDDEN_KEYS, key)) return true;
  }
  return false;
}

export function revokeCanaryRoute(routeRef: string): void {
  revokedRoutes.add(routeRef);
  for (const e of defaultRegistry.list()) {
    if (e.receiver?.routeRef === routeRef) {
      defaultRegistry.revokeRoute(e.canaryId);
    }
  }
}

export function isCanaryRouteRevoked(routeRef: string): boolean {
  return revokedRoutes.has(routeRef);
}

/** Test helper — clears process-local dedup/revoke/registry state. */
export function resetCanaryStateForTests(): void {
  resetCanaryExecutorState();
  revokedRoutes.clear();
  defaultRegistry.clear();
}

/**
 * Enroll the shipped honeytoken_open canary type with an optional ALERT receiver.
 * Does not grant production authority (CANARY-A).
 */
export function enrollHoneytokenCanary(input: {
  canaryId: string;
  tokenFingerprint: string;
  receiver?: CanaryEnrollment["receiver"];
}): CanaryEnrollment {
  return defaultRegistry.enrollHoneytoken(input);
}

export function getEnrolledCanary(
  canaryId: string,
): CanaryEnrollment | undefined {
  return defaultRegistry.get(canaryId);
}

export type CanaryExecuteRequest = Readonly<{
  event: BoundaryValue;
  enrolledRouteRefs: readonly string[];
  action?: string;
  params?: JsonObject;
}>;

export type CanaryExecuteResult =
  | { ok: true; result: CanaryResult }
  | {
      ok: false;
      code: "contradictory_actions" | "unapproved_route" | "unsupported_factor";
    };

/**
 * Schema+executor ceiling: detection/notify only (CANARY-B/F).
 * Destructive actions/params fail closed.
 */
function parseCanaryEvent(
  event: BoundaryValue,
): ReturnType<typeof parseActivation> | CanaryExecuteResult {
  try {
    return parseActivation(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("contradictory_actions") || msg.includes("destructive")) {
      return { ok: false, code: "contradictory_actions" };
    }
    return { ok: false, code: "unsupported_factor" };
  }
}

function routeRefFromEvent(event: BoundaryValue): string {
  if (!isJsonObject(event)) return "";
  const routeRef = overlapCast<{ routeRef?: BoundaryValue }>(event).routeRef;
  return isString(routeRef) ? routeRef : "";
}

function revokedCanaryHit(canaryId: string): CanaryExecuteResult {
  return {
    ok: true,
    result: {
      kind: "detection_only",
      canaryId,
      deduped: true,
      notified: false,
      alertQueued: false,
      alertSuppressed: false,
      matched: true,
    },
  };
}

export function executeCanary(
  request: CanaryExecuteRequest,
): CanaryExecuteResult {
  if (
    request.action &&
    request.action !== "detect" &&
    request.action !== "notify"
  ) {
    return { ok: false, code: "contradictory_actions" };
  }
  if (request.params && hasForbiddenKey(request.params)) {
    return { ok: false, code: "contradictory_actions" };
  }

  const parsed = parseCanaryEvent(request.event);
  if ("ok" in parsed) return parsed;
  const event = parsed;

  const routeRef = routeRefFromEvent(request.event);
  if (!routeRef || !request.enrolledRouteRefs.includes(routeRef)) {
    return { ok: false, code: "unapproved_route" };
  }
  if (revokedRoutes.has(routeRef)) {
    return revokedCanaryHit(event.canaryId);
  }

  const hit = recordHit({
    canaryId: event.canaryId,
    detectedAt: event.detectedAt,
  });
  return { ok: true, result: hit };
}

/** False-positive bound: identical canaryId within window counts as one notify. */
export type CanaryFalsePositiveBound = Readonly<{
  notifications: number;
  detections: number;
}>;

export function canaryFalsePositiveBound(
  hits: readonly CanaryResult[],
): CanaryFalsePositiveBound {
  return {
    detections: hits.length,
    notifications: hits.filter((h) => h.notified).length,
  } satisfies CanaryFalsePositiveBound;
}
