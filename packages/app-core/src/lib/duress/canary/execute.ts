/**
 * Detection-only canary executor (CANARY-B..F).
 * Schema + executor both refuse destructive injection; never mints production authority.
 */

import type { AlertOutbox } from "../alert/outbox.js";
import type {
  AlertSealingMaterial,
  SealedAlertPackage,
} from "../alert/seal.js";
import { sealAlertPackage } from "../alert/seal.js";
import {
  type BoundaryValue,
  includesStringLiteral,
  isJsonObject,
} from "../json-boundary.js";
import {
  CANARY_BOUNDS,
  CANARY_FORBIDDEN_KEYS,
  type CanaryActivation,
  type CanaryEnrollment,
  CanarySchemaError,
  assertNoForbiddenCanaryKeys,
  parseCanaryActivation,
} from "./schema.js";

export type CanaryResult = Readonly<{
  kind: "detection_only";
  canaryId: string;
  deduped: boolean;
  /** Legacy notify flag: first non-deduped matched hit (compat with record/execute). */
  notified: boolean;
  alertQueued: boolean;
  /** True when false-positive bound suppressed further alerts. */
  alertSuppressed: boolean;
  matched: boolean;
}>;

export type CanaryExecuteOutcome =
  | { ok: true; result: CanaryResult; sealed?: SealedAlertPackage }
  | { ok: false; code: string; message: string };

type HitBucket = { windowStart: number; count: number };

const recentDedup = new Map<string, number>();
const hitBuckets = new Map<string, HitBucket>();

/** Test/harness reset — disposable fixtures only. */
export function resetCanaryExecutorState(): void {
  recentDedup.clear();
  hitBuckets.clear();
}

function assertNoDestructiveInjection(input: BoundaryValue): void {
  if (!isJsonObject(input)) return;
  assertNoForbiddenCanaryKeys(input, "executor");
  for (const key of Object.keys(input)) {
    if (includesStringLiteral(CANARY_FORBIDDEN_KEYS, key)) {
      throw new CanarySchemaError(
        "contradictory_actions",
        `executor rejected destructive injection '${key}'`,
      );
    }
    const val = input[key];
    if (isJsonObject(val)) {
      assertNoDestructiveInjection(val);
    }
  }
}

type CanaryHitNote = Readonly<{ deduped: boolean; suppressAlert: boolean }>;

function noteHit(canaryId: string, now: number): CanaryHitNote {
  const last = recentDedup.get(canaryId) ?? 0;
  const deduped = now - last < CANARY_BOUNDS.dedupWindowMs;
  if (!deduped) recentDedup.set(canaryId, now);

  let bucket = hitBuckets.get(canaryId);
  if (
    !bucket ||
    now - bucket.windowStart >= CANARY_BOUNDS.falsePositiveWindowMs
  ) {
    bucket = { windowStart: now, count: 0 };
    hitBuckets.set(canaryId, bucket);
  }
  if (!deduped) bucket.count += 1;
  const suppressAlert = bucket.count > CANARY_BOUNDS.falsePositiveMaxHits;
  return { deduped, suppressAlert } satisfies CanaryHitNote;
}

function fingerprintsMatch(
  enrollment: CanaryEnrollment,
  activation: CanaryActivation,
): boolean {
  if (activation.tokenFingerprint.startsWith("legacy-route:")) {
    // Legacy parseCanaryActivation path: match by canaryId enrollment only.
    return activation.canaryId === enrollment.canaryId;
  }
  if (activation.tokenFingerprint.length < CANARY_BOUNDS.fingerprintMin) {
    return false;
  }
  return (
    activation.canaryId === enrollment.canaryId &&
    activation.tokenFingerprint === enrollment.tokenFingerprint
  );
}

/**
 * Record a canary hit without enrollment lookup (compat helper).
 * Always detection_only — never grants sessions/keys.
 */
export function recordCanaryHit(
  event: { canaryId: string; detectedAt?: string },
  windowMs = CANARY_BOUNDS.dedupWindowMs,
): CanaryResult {
  const now = Date.now();
  const last = recentDedup.get(event.canaryId) ?? 0;
  const deduped = now - last < windowMs;
  if (!deduped) recentDedup.set(event.canaryId, now);
  return {
    kind: "detection_only",
    canaryId: event.canaryId,
    deduped,
    notified: !deduped,
    alertQueued: false,
    alertSuppressed: false,
    matched: true,
  };
}

/**
 * Execute detection against an enrolled canary.
 * - Rejects destructive injection (executor ceiling).
 * - Dedups within window.
 * - Suppresses alerts past false-positive bounds (detection still recorded).
 * - Skips alert when route revoked or receiver absent.
 * - Never opens root, mints session, or performs removal.
 */
function unmatchedCanaryResult(canaryId: string): CanaryExecuteOutcome {
  return {
    ok: true,
    result: {
      kind: "detection_only",
      canaryId,
      deduped: false,
      notified: false,
      alertQueued: false,
      alertSuppressed: false,
      matched: false,
    },
  };
}

type QueueCanaryAlertInput = Readonly<{
  enrollment: CanaryEnrollment;
  activation: CanaryActivation;
  outbox: AlertOutbox;
  sealingKey: AlertSealingMaterial;
  incidentId?: string;
  profileId?: string;
  policyRevision?: number;
  keyEpoch?: number;
  now: number;
}>;

async function queueCanaryAlert(
  input: QueueCanaryAlertInput,
): Promise<SealedAlertPackage> {
  const receiver = input.enrollment.receiver;
  if (!receiver) {
    throw new CanarySchemaError("unapproved_route", "canary receiver missing");
  }
  const sealed = await sealAlertPackage({
    incidentId: input.incidentId ?? `canary-${input.activation.canaryId}`,
    profileId: input.profileId ?? `canary-profile-${input.activation.canaryId}`,
    routeRef: receiver.routeRef,
    templateRef: receiver.templateRef,
    payload: {
      event: "canary_detection",
      canaryId: input.activation.canaryId,
      kind: "honeytoken_open",
    },
    sealingKey: input.sealingKey,
    expiryMs: receiver.expiryMs,
    policyRevision: input.policyRevision ?? 1,
    keyEpoch: input.keyEpoch ?? 1,
    now: input.now,
  });
  input.outbox.enqueue(sealed, receiver.maxRetries);
  return sealed;
}

export type CanaryDetectionInput = Readonly<{
  enrollment: CanaryEnrollment;
  activation: BoundaryValue;
  outbox?: AlertOutbox;
  /** Independent alert sealing material (ALERT-to-CANARY): encryptKey+macKey. */
  sealingKey?: AlertSealingMaterial;
  incidentId?: string;
  profileId?: string;
  policyRevision?: number;
  keyEpoch?: number;
  now?: number;
}>;

export async function executeCanaryDetection(
  input: CanaryDetectionInput,
): Promise<CanaryExecuteOutcome> {
  try {
    assertNoDestructiveInjection(input.activation);
    if (input.enrollment.kind !== "honeytoken_open") {
      return {
        ok: false,
        code: "unsupported_factor",
        message: "only honeytoken_open canaries are executable",
      };
    }

    const activation = parseCanaryActivation(input.activation);
    const now = input.now ?? Date.now();
    if (!fingerprintsMatch(input.enrollment, activation)) {
      return unmatchedCanaryResult(activation.canaryId);
    }

    const { deduped, suppressAlert } = noteHit(activation.canaryId, now);
    const receiver = input.enrollment.receiver;
    const canAlert =
      !deduped &&
      !suppressAlert &&
      !input.enrollment.routeRevoked &&
      receiver !== null &&
      input.outbox !== undefined &&
      input.sealingKey !== undefined;

    let sealed: SealedAlertPackage | undefined;
    if (canAlert && input.outbox && input.sealingKey) {
      sealed = await queueCanaryAlert({
        enrollment: input.enrollment,
        activation,
        outbox: input.outbox,
        sealingKey: input.sealingKey,
        incidentId: input.incidentId,
        profileId: input.profileId,
        policyRevision: input.policyRevision,
        keyEpoch: input.keyEpoch,
        now,
      } satisfies QueueCanaryAlertInput);
    }

    return {
      ok: true,
      result: {
        kind: "detection_only",
        canaryId: activation.canaryId,
        deduped,
        notified: !deduped,
        alertQueued: sealed !== undefined,
        alertSuppressed: suppressAlert,
        matched: true,
      },
      sealed,
    };
  } catch (err) {
    if (err instanceof CanarySchemaError) {
      return { ok: false, code: err.code, message: err.message };
    }
    const message =
      err instanceof Error ? err.message : "canary_execute_failed";
    return { ok: false, code: "unsupported_factor", message };
  }
}

export type DestructiveCanaryRefusal = Readonly<{
  ok: false;
  code: "contradictory_actions";
  message: string;
}>;

/**
 * Executor-level refuse for injected destructive action bags (CANARY-B/F).
 * Always fails closed — canary has no destructive capability surface.
 */
export function refuseDestructiveCanaryAction(
  action: BoundaryValue,
): DestructiveCanaryRefusal {
  try {
    assertNoDestructiveInjection(action);
  } catch (err) {
    if (err instanceof CanarySchemaError) {
      return { ok: false, code: "contradictory_actions", message: err.message };
    }
  }
  if (isJsonObject(action)) {
    const kind = action.kind;
    if (
      kind === "local_enumerated" ||
      kind === "wipe" ||
      kind === "mint_session" ||
      kind === "open_root"
    ) {
      return {
        ok: false,
        code: "contradictory_actions",
        message: "canary executor has no destructive capability",
      };
    }
  }
  return {
    ok: false,
    code: "contradictory_actions",
    message: "canary executor is detection-only",
  };
}
