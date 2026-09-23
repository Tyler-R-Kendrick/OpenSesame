/**
 * Incident activation — durable intent first, then local fence, then optional alert queue (STORE-C/D).
 * Alert enqueue never requires the protected vault root.
 */

import {
  type PresentationClass,
  issueAccessContext,
} from "../access/context.js";
import type { AlertOutbox, SealedAlertPackage } from "../alert/outbox.js";
import { duressSessionFence } from "../session/fence.js";
import {
  type ActivationHost,
  coordinateActivation,
} from "../store/activation-coordinator.js";
import { canRunRootlessEffects } from "../store/opaque-metadata.js";
import {
  type IncidentIntent,
  loadIncidentIntent,
  recoverIncidentFenceAfterRestart,
  writeIncidentIntent,
  writeIncidentRecord,
} from "./intent-journal.js";

export type ActivationInput = Readonly<{
  incidentId: string;
  profileId: string;
  presentation: PresentationClass;
  admittedCompartmentRefs: readonly string[];
  denyOperations: readonly string[];
  authorizationCeiling: readonly string[];
  policyRevision: number;
  keyEpoch: number;
  principalRef: string;
  vaultRef: string;
  deviceBindingRef: string;
  evidenceDigest: string;
  alertPackage?: SealedAlertPackage;
  requireDurable?: boolean;
}>;

export type ActivationResult = {
  fence: ReturnType<typeof duressSessionFence.readFence>;
  context: ReturnType<typeof issueAccessContext>;
  intent: IncidentIntent;
  coordination: Awaited<ReturnType<typeof coordinateActivation>> | null;
};

function buildActivationIntent(input: ActivationInput): IncidentIntent {
  return {
    incidentId: input.incidentId,
    profileId: input.profileId,
    policyRevision: input.policyRevision,
    keyEpoch: input.keyEpoch,
    state: "active",
    presentation: input.presentation,
    admittedCompartmentRefs: input.admittedCompartmentRefs,
    denyOperations: input.denyOperations,
    scopeSnapshot: {
      vaultRef: input.vaultRef,
      deviceBindingRef: input.deviceBindingRef,
      compartmentRefs: [...input.admittedCompartmentRefs],
    },
    activationEvidenceDigest: input.evidenceDigest,
    fenceApplied: false,
  };
}

async function persistActivationJournals(
  input: ActivationInput,
  intent: IncidentIntent,
  localRevision: number,
): Promise<void> {
  const now = new Date().toISOString();
  const recordResult = await writeIncidentRecord(
    {
      schemaVersion: 1,
      incidentId: input.incidentId,
      profileId: input.profileId,
      policyRevision: input.policyRevision,
      keyEpoch: input.keyEpoch,
      incidentEpoch: duressSessionFence.readFence().incidentEpoch + 1,
      localRevision,
      state: "active",
      scopeSnapshot: intent.scopeSnapshot,
      activationEvidenceDigest: input.evidenceDigest,
      effects: {
        presentation: "pending",
        hold: "not_requested",
        alert: input.alertPackage ? "pending" : "not_requested",
        quarantine: "not_requested",
        providerRevocation: "not_requested",
        removal: "not_requested",
      },
      createdAt: now,
      updatedAt: now,
    },
    { requireDurable: input.requireDurable ?? true },
  );
  if (!recordResult.ok) {
    throw new Error(`${recordResult.code}: ${recordResult.message}`);
  }
}

type FenceContextApplyResult = Readonly<{
  fence: ReturnType<typeof duressSessionFence.readFence>;
  context: ReturnType<typeof issueAccessContext>;
  appliedIntent: IncidentIntent;
}>;

function applyFenceAndContext(
  input: ActivationInput,
  intent: IncidentIntent,
): FenceContextApplyResult {
  const fence = duressSessionFence.activate({
    incidentId: input.incidentId,
    policyRevision: input.policyRevision,
    keyEpoch: input.keyEpoch,
    denyOperations: input.denyOperations,
    admittedCompartmentRefs: input.admittedCompartmentRefs,
  });
  const appliedIntent: IncidentIntent = { ...intent, fenceApplied: true };
  const context = issueAccessContext({
    principalRef: input.principalRef,
    tenantRef: null,
    vaultRef: input.vaultRef,
    compartmentRefs: input.admittedCompartmentRefs,
    deviceBindingRef: input.deviceBindingRef,
    presentation: input.presentation,
    authorizationCeiling: input.authorizationCeiling,
    denyOperations: fence.denyOperations,
    policyRevision: input.policyRevision,
    incidentEpoch: fence.incidentEpoch,
    keyEpoch: input.keyEpoch,
    sessionGeneration: duressSessionFence.guard.generation,
    profileId: input.profileId,
    evidenceDigest: input.evidenceDigest,
  });
  duressSessionFence.setContext(context);
  return { fence, context, appliedIntent } satisfies FenceContextApplyResult;
}

/**
 * Persist incident intent, optionally coordinate vault write flush, apply fence,
 * then enqueue alerts. Network effects stay async relative to unlock.
 */
type Options = Readonly<{
  outbox?: AlertOutbox;
  host?: ActivationHost;
}>;
const defaultOptions = {} satisfies Options;

export async function activateDuressIncident(
  input: ActivationInput,
  options: Options = defaultOptions,
): Promise<ActivationResult> {
  const intent = buildActivationIntent(input);
  const journaled = await writeIncidentIntent(intent, {
    requireDurable: input.requireDurable ?? true,
  });
  if (!journaled.ok) {
    throw new Error(`${journaled.code}: ${journaled.message}`);
  }
  await persistActivationJournals(input, intent, journaled.revision);

  const coordination = options.host
    ? await coordinateActivation(options.host)
    : null;
  const { fence, context, appliedIntent } = applyFenceAndContext(input, intent);
  await writeIncidentIntent(appliedIntent, {
    requireDurable: input.requireDurable ?? false,
  });

  if (
    input.alertPackage &&
    options.outbox &&
    canRunRootlessEffects(appliedIntent)
  ) {
    options.outbox.enqueue(input.alertPackage, 3);
  }

  return { fence, context, intent: appliedIntent, coordination };
}

/** Idempotent restart recovery for crash-consistent local fences. */
export function recoverDuressIncidentAfterRestart(): {
  recovered: boolean;
  intent: IncidentIntent | null;
} {
  return recoverIncidentFenceAfterRestart();
}

export function currentIncidentIntent(): IncidentIntent | null {
  return loadIncidentIntent();
}
