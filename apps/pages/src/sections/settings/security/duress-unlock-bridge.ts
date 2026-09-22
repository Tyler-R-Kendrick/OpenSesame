/**
 * SETTINGS → TRIGGER unlock bridge (INV-03).
 * Complete code submissions only — never prefix-match or auto-trigger.
 * UnlockScreen / UnlockMethodsPanel call this before vault key release.
 */

import type { PresentationClass } from "../../../lib/duress/access/context.js";
import {
  type UnlockCeremonyDeps,
  routeCompleteUnlockSubmission,
} from "../../../lib/duress/ceremony/unlock-adapter.js";
import { activateDuressIncident } from "../../../lib/duress/incident/activate.js";
import {
  ENROLLMENT_STATE_KEY,
  clearEnrollmentStateForUnlock,
  loadEnrollmentStateForUnlock,
  persistEnrollmentStateForUnlock,
} from "../../../lib/duress/store/unlock-enrollment.js";
import { TriggerAttemptPolicy } from "../../../lib/duress/trigger/attempt-policy.js";
import type {
  EnrollmentState,
  SelectTriggerOptions,
  TriggerMatch,
} from "../../../lib/duress/trigger/enrollment.js";

export {
  clearEnrollmentStateForUnlock,
  loadEnrollmentStateForUnlock,
  persistEnrollmentStateForUnlock,
  ENROLLMENT_STATE_KEY,
};
export type { JournalWriteResult } from "../../../lib/duress/store/journal.js";

const attemptPolicy = new TriggerAttemptPolicy();

export type UnlockDuressOutcome =
  | { kind: "inactive" }
  | { kind: "normal" }
  | { kind: "throttled" }
  | { kind: "ambiguous" }
  | { kind: "stale_policy" }
  | { kind: "duress"; match: Extract<TriggerMatch, { status: "matched" }> };

function asPresentation(value: string): PresentationClass {
  if (
    value === "normal" ||
    value === "restricted" ||
    value === "decoy" ||
    value === "locked" ||
    value === "unchanged"
  ) {
    return value;
  }
  return "restricted";
}

/**
 * Route a complete unlock code through TRIGGER before any vault unwrap.
 * Matched duress activates the incident fence and must not open the root vault.
 */
type UnlockBridgeOptions = Readonly<{
  state?: EnrollmentState | null;
  loadState?: () => EnrollmentState | null;
  deps?: UnlockCeremonyDeps;
  requireDurable?: boolean;
  /** UV / PRF / origin binding for two-input triggers. */
  select?: SelectTriggerOptions;
}>;
const defaultUnlockBridgeOptions = {} satisfies UnlockBridgeOptions;

function newIncidentId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && "randomUUID" in cryptoRef) {
    return cryptoRef.randomUUID();
  }
  return `duress-${Date.now()}`;
}

export async function onCompleteUnlockCodeSubmission(
  code: string,
  options: UnlockBridgeOptions = defaultUnlockBridgeOptions,
): Promise<UnlockDuressOutcome> {
  const state =
    options.state !== undefined
      ? options.state
      : (options.loadState ?? loadEnrollmentStateForUnlock)();
  if (!state || !state.armed || state.triggers.length === 0) {
    return { kind: "inactive" };
  }

  const match = await routeCompleteUnlockSubmission({
    code,
    state,
    attempts: attemptPolicy,
    options: options.select,
  });

  if (match.status === "throttled") return { kind: "throttled" };
  if (match.status === "ambiguous") return { kind: "ambiguous" };
  if (match.status === "stale_policy") return { kind: "stale_policy" };
  if (match.status === "none") return { kind: "normal" };

  const presentation = asPresentation(match.plaintext.presentation);
  const admitted = [`compartment:${match.profileId}`];
  await activateDuressIncident({
    incidentId: newIncidentId(),
    profileId: match.profileId,
    presentation,
    admittedCompartmentRefs: admitted,
    denyOperations: ["export", "share", "mint_capability", "invoke_through"],
    authorizationCeiling: ["guest"],
    policyRevision: state.policyRevision,
    keyEpoch: state.keyEpoch,
    principalRef: "local-owner",
    vaultRef: state.vaultRef,
    deviceBindingRef: state.deviceBindingRef,
    evidenceDigest: `trigger:${match.triggerKind}:${match.profileId}`,
    requireDurable: options.requireDurable ?? true,
  });

  match.plaintext.compartmentKey.fill(0);
  match.plaintext.actionCapability?.fill(0);

  return { kind: "duress", match };
}

export { routeCompleteUnlockSubmission };
