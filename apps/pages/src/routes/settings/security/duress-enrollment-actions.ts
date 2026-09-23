import {
  type ArmingChecklist,
  type CodeSlotStatus,
  type PresetId,
  type PresetMeta,
  type RecipientPlan,
  activationRequiresNewPermissionPrompt,
  armPersistedUnlockEnrollment,
  assertNoEnrolledCodeDisplay,
  disarmPersistedUnlockEnrollment,
  disarmProfile,
  rehearsalSatisfiesArming,
  replaceEnrolledCode,
  runIsolatedRehearsal,
  sealUnlockTriggerFromCeremony,
  validateRecipientSetup,
} from "@opensesame/app-core/lib/duress/settings/index.js";
import type { EnrollmentState } from "@opensesame/app-core/lib/duress/trigger/enrollment.js";
import type { PolicyDocument } from "@opensesame/contracts";
import type { Dispatch, FormEvent, SetStateAction } from "react";

export function toggleArmingChecklist(
  setChecklist: Dispatch<SetStateAction<ArmingChecklist>>,
  key: keyof ArmingChecklist,
  value: boolean,
): void {
  setChecklist((c) => ({ ...c, [key]: value }));
}

export function runEnrollmentRehearsal(input: {
  catalogDurableStorage: boolean;
  document: PolicyDocument | null;
  setRehearsalNote: (note: string | null) => void;
  toggleCheck: (key: keyof ArmingChecklist, value: boolean) => void;
}): void {
  const result = runIsolatedRehearsal({
    disposableFixtures: true,
    durableStorage: input.catalogDurableStorage,
    offlineAssetsReady: true,
    triggerSelectsExactlyOne: true,
    presentationClass:
      input.document?.profiles[0]?.effects.presentation ?? "unchanged",
    expectedPresentationClass:
      input.document?.profiles[0]?.effects.presentation ?? "unchanged",
    attemptedProductionAlert: false,
    attemptedProductionRemoval: false,
  });
  const ok = rehearsalSatisfiesArming(result);
  input.toggleCheck("rehearsalPassed", ok);
  input.setRehearsalNote(
    ok
      ? "Isolated rehearsal passed — no production effects applied."
      : `Rehearsal ${result.phase}: ${result.checks.find((c) => !c.ok)?.detail ?? "failed"}`,
  );
}

export async function submitEnrolledCodeReplacement(input: {
  event: FormEvent;
  document: PolicyDocument | null;
  codeDraft: string;
  prevCodeDraft: string;
  slot: CodeSlotStatus | null;
  scope: { vaultRef: string; deviceBindingRef: string };
  enrollmentState: EnrollmentState | null;
  setCodeDraft: (value: string) => void;
  setPrevCodeDraft: (value: string) => void;
  setCodeError: (value: string | null) => void;
  setEnrollmentState: (value: EnrollmentState | null) => void;
  setSlot: (value: CodeSlotStatus | null) => void;
  toggleCheck: (key: keyof ArmingChecklist, value: boolean) => void;
}): Promise<void> {
  input.event.preventDefault();
  input.setCodeError(null);
  const profileId = input.document?.profiles[0]?.profileId ?? "profile";
  const freshCode = input.codeDraft;
  const outcome = await replaceEnrolledCode(
    {
      slotId: "slot-1",
      profileId,
      newCode: freshCode,
      previousCode: input.slot?.enrolled ? input.prevCodeDraft : undefined,
    },
    input.slot,
  );
  input.setCodeDraft("");
  input.setPrevCodeDraft("");
  if (!outcome.ok) {
    input.setCodeError(outcome.reason);
    return;
  }
  const leak = assertNoEnrolledCodeDisplay(outcome.status);
  if (!leak.ok) {
    input.setCodeError(`leak_blocked:${leak.leakedKeys.join(",")}`);
    return;
  }
  try {
    const sealed = await sealUnlockTriggerFromCeremony({
      code: freshCode,
      profileId,
      vaultRef: input.scope.vaultRef,
      deviceBindingRef: input.scope.deviceBindingRef,
      presentation:
        input.document?.profiles[0]?.effects.presentation ?? "restricted",
      previous: input.enrollmentState,
      ownerConsent: true,
    });
    input.setEnrollmentState(sealed);
  } catch (err) {
    input.setCodeError(
      err instanceof Error ? err.message : "seal_trigger_failed",
    );
    return;
  }
  input.setSlot(outcome.status);
  input.toggleCheck("enrolledTriggers", true);
}

export async function disarmEnrollmentProfile(input: {
  slot: CodeSlotStatus | null;
  setSlot: (value: CodeSlotStatus | null) => void;
  setArmed: (armed: boolean) => void;
  setEnrollmentState: (value: EnrollmentState | null) => void;
  toggleCheck: (key: keyof ArmingChecklist, value: boolean) => void;
  onDisarm?: () => void;
}): Promise<void> {
  if (input.slot) input.setSlot(disarmProfile(input.slot));
  input.setArmed(false);
  input.setEnrollmentState(null);
  input.toggleCheck("enrolledTriggers", false);
  await disarmPersistedUnlockEnrollment();
  input.onDisarm?.();
}

export async function armEnrollmentProfile(input: {
  document: PolicyDocument | null;
  armReady: boolean;
  preset: PresetMeta;
  mode: "preset" | "advanced";
  presetId: PresetId;
  recipients: RecipientPlan[];
  enrollmentState: EnrollmentState | null;
  checklist: ArmingChecklist;
  setRehearsalNote: (note: string | null) => void;
  setEnrollmentState: (value: EnrollmentState | null) => void;
  setArmed: (armed: boolean) => void;
  onArm?: (args: {
    checklist: ArmingChecklist;
    presetId: PresetId | null;
    document: PolicyDocument;
  }) => void;
}): Promise<void> {
  if (!input.document || !input.armReady) return;
  if (activationRequiresNewPermissionPrompt()) return;
  const needs = validateRecipientSetup(input.recipients, {
    recipient: input.preset.requiresRecipient && input.mode === "preset",
    custodian: input.preset.requiresCustodian && input.mode === "preset",
  });
  if (!needs.ok && input.mode === "preset") {
    input.setRehearsalNote(`Recipient setup: ${needs.reason}`);
    return;
  }
  if (!input.enrollmentState || input.enrollmentState.triggers.length === 0) {
    input.setRehearsalNote("Arm blocked: enroll a sealed unlock code first.");
    return;
  }
  if (!input.checklist.ownerConsent) {
    input.setRehearsalNote("Arm blocked: owner consent required.");
    return;
  }
  const persisted = await armPersistedUnlockEnrollment({
    ...input.enrollmentState,
    ownerConsent: true,
  });
  if (!persisted.ok) {
    input.setRehearsalNote(`Arm failed: ${persisted.message}`);
    return;
  }
  input.setEnrollmentState({
    ...input.enrollmentState,
    armed: true,
    ownerConsent: true,
  });
  input.setArmed(true);
  input.onArm?.({
    checklist: input.checklist,
    presetId: input.mode === "preset" ? input.presetId : null,
    document: input.document,
  });
}
