/**
 * Draft enrollment flow with isolated rehearsal before commit (TRIGGER-A).
 */

import {
  MAX_SLOTS,
  type SlotPlaintext,
  assertTriggerCodeLength,
  openProfileSlot,
  sealProfileSlot,
} from "../crypto/slots.js";
import { defined } from "../defined.js";
import {
  type EnrollmentDraft,
  type EnrollmentState,
  assertNoCollisions,
  assertOwnerAndReadiness,
  expectFrom,
  normalizeState,
} from "./enrollment-state.js";
import { type CodeTriggerKind, assertCapabilitiesForKind } from "./kinds.js";

export type BeginEnrollmentDraftOpts = Readonly<{ replaceProfileId?: string }>;

export type StageTriggerInDraftInput = Readonly<{
  draft: EnrollmentDraft;
  code: string;
  profileId: string;
  triggerKind: CodeTriggerKind;
  plaintext: SlotPlaintext;
  ordinaryCode?: string;
  credentialIdB64?: string;
  expectedOrigin?: string;
  prfEnvelopeRef?: string;
}>;

export function beginEnrollmentDraft(
  state: EnrollmentState,
  opts?: BeginEnrollmentDraftOpts,
): EnrollmentDraft {
  const normalized = normalizeState(state);
  assertOwnerAndReadiness(normalized);
  return beginDraftInternal(normalized, opts);
}

function beginDraftInternal(
  normalized: EnrollmentState,
  opts?: BeginEnrollmentDraftOpts,
): EnrollmentDraft {
  return {
    stateSnapshot: {
      ...normalized,
      triggers: [...normalized.triggers],
      ordinaryCodeFingerprints: [...normalized.ordinaryCodeFingerprints],
      capabilities: { ...defined(normalized.capabilities, "capabilities") },
    },
    pending: null,
    rehearsalCode: null,
    rehearsalPassed: false,
    profileId: null,
    replaceProfileId: opts?.replaceProfileId ?? null,
  };
}

export async function stageTriggerInDraft(
  input: StageTriggerInDraftInput,
): Promise<EnrollmentDraft> {
  const state = input.draft.stateSnapshot;
  assertCapabilitiesForKind(
    input.triggerKind,
    defined(normalizeState(state).capabilities, "capabilities"),
  );

  const replacing = input.draft.replaceProfileId ?? undefined;
  if (replacing && replacing !== input.profileId) {
    throw new Error("scope_mismatch: replace profile id mismatch");
  }

  const activeCount = state.triggers.filter(
    (t) => !replacing || t.slot.profileId !== replacing,
  ).length;
  if (activeCount >= MAX_SLOTS) {
    throw new Error("unsupported_factor: slot limit");
  }

  await assertNoCollisions({
    code: input.code,
    state,
    ordinaryCode: input.ordinaryCode,
    ignoreProfileId: replacing,
  });

  if (input.triggerKind === "prf_and_code") {
    if (!input.credentialIdB64 || !input.expectedOrigin) {
      throw new Error(
        "unsupported_factor: prf_and_code requires credential and origin binding",
      );
    }
  }

  const slot = await sealProfileSlot({
    code: input.code,
    slotId: `slot-${input.profileId}-${state.policyRevision}-${state.keyEpoch}`,
    profileId: input.profileId,
    vaultRef: state.vaultRef,
    deviceBindingRef: state.deviceBindingRef,
    policyRevision: state.policyRevision,
    keyEpoch: state.keyEpoch,
    plaintext: input.plaintext,
  });

  return {
    ...input.draft,
    pending: {
      slot,
      triggerKind: input.triggerKind,
      credentialIdB64: input.credentialIdB64,
      expectedOrigin: input.expectedOrigin,
      prfEnvelopeRef: input.prfEnvelopeRef,
    },
    rehearsalCode: input.code,
    rehearsalPassed: false,
    profileId: input.profileId,
  };
}

export async function runIsolatedRehearsal(
  draft: EnrollmentDraft,
): Promise<EnrollmentDraft> {
  if (!draft.pending || !draft.rehearsalCode || !draft.profileId) {
    throw new Error("recovery_required: nothing staged for rehearsal");
  }
  const opened = await openProfileSlot(
    draft.rehearsalCode,
    draft.pending.slot,
    expectFrom(draft.stateSnapshot),
  );
  if (!opened) {
    throw new Error("recovery_required: isolated rehearsal failed");
  }
  opened.compartmentKey.fill(0);
  if (opened.actionCapability) opened.actionCapability.fill(0);
  return { ...draft, rehearsalPassed: true };
}

export function commitEnrollmentDraft(draft: EnrollmentDraft): EnrollmentState {
  if (!draft.pending || !draft.profileId) {
    throw new Error("recovery_required: nothing to commit");
  }
  if (!draft.rehearsalPassed) {
    throw new Error("recovery_required: isolated rehearsal required");
  }
  if (!draft.stateSnapshot.ownerConsent) {
    throw new Error("recovery_required: owner consent missing");
  }

  const replaceId = draft.replaceProfileId ?? draft.profileId;
  const retained = draft.stateSnapshot.triggers.filter(
    (t) => t.slot.profileId !== replaceId,
  );

  return {
    ...draft.stateSnapshot,
    triggers: [...retained, draft.pending],
    rehearsalPassed: true,
    armed: true,
  };
}

export async function enrollTrigger(input: {
  state: EnrollmentState;
  code: string;
  profileId: string;
  triggerKind: CodeTriggerKind;
  plaintext: SlotPlaintext;
  ordinaryCode?: string;
  replace?: boolean;
  credentialIdB64?: string;
  expectedOrigin?: string;
  prfEnvelopeRef?: string;
  autoRehearse?: boolean;
}): Promise<EnrollmentState> {
  assertTriggerCodeLength(input.code);
  const state = normalizeState(input.state);
  assertOwnerAndReadiness(state);
  assertCapabilitiesForKind(
    input.triggerKind,
    defined(state.capabilities, "capabilities"),
  );

  const existing = state.triggers.find(
    (t) => t.slot.profileId === input.profileId,
  );
  const replace = input.replace ?? Boolean(existing);

  if (input.autoRehearse === false) {
    if (!state.rehearsalPassed) {
      throw new Error("recovery_required: isolated rehearsal required");
    }
    await assertNoCollisions({
      code: input.code,
      state,
      ordinaryCode: input.ordinaryCode,
      ignoreProfileId: replace ? input.profileId : undefined,
    });
    if (!replace && state.triggers.length >= MAX_SLOTS) {
      throw new Error("unsupported_factor: slot limit");
    }
    if (input.triggerKind === "prf_and_code") {
      if (!input.credentialIdB64 || !input.expectedOrigin) {
        throw new Error(
          "unsupported_factor: prf_and_code requires credential and origin binding",
        );
      }
    }
    const slot = await sealProfileSlot({
      code: input.code,
      slotId: `slot-${state.triggers.length + 1}`,
      profileId: input.profileId,
      vaultRef: state.vaultRef,
      deviceBindingRef: state.deviceBindingRef,
      policyRevision: state.policyRevision,
      keyEpoch: state.keyEpoch,
      plaintext: input.plaintext,
    });
    const retained = replace
      ? state.triggers.filter((t) => t.slot.profileId !== input.profileId)
      : [...state.triggers];
    return {
      ...state,
      triggers: [
        ...retained,
        {
          slot,
          triggerKind: input.triggerKind,
          credentialIdB64: input.credentialIdB64,
          expectedOrigin: input.expectedOrigin,
          prfEnvelopeRef: input.prfEnvelopeRef,
        },
      ],
      armed: true,
    };
  }

  let draft = beginEnrollmentDraft(state, {
    replaceProfileId: replace ? input.profileId : undefined,
  } satisfies BeginEnrollmentDraftOpts);
  draft = await stageTriggerInDraft({
    draft,
    code: input.code,
    profileId: input.profileId,
    triggerKind: input.triggerKind,
    plaintext: input.plaintext,
    ordinaryCode: input.ordinaryCode,
    credentialIdB64: input.credentialIdB64,
    expectedOrigin: input.expectedOrigin,
    prfEnvelopeRef: input.prfEnvelopeRef,
  } satisfies StageTriggerInDraftInput);
  draft = await runIsolatedRehearsal(draft);
  return commitEnrollmentDraft(draft);
}
