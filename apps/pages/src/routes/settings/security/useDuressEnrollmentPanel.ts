import type { ArmingChecklist } from "@opensesame/app-core/lib/duress/settings/index.js";
import { deriveEnrollmentPanel } from "@opensesame/app-core/routes/settings/security/duress-enrollment-derived.js";
import { type FormEvent, useMemo } from "react";
import type { DuressEnrollmentPanelProps } from "./DuressEnrollmentPanel.js";
import {
  armEnrollmentProfile,
  disarmEnrollmentProfile,
  runEnrollmentRehearsal,
  submitEnrolledCodeReplacement,
  toggleArmingChecklist,
} from "./duress-enrollment-actions.js";
import { useDuressEnrollmentState } from "./useDuressEnrollmentState.js";

export type DuressEnrollmentViewModel = ReturnType<
  typeof useDuressEnrollmentPanel
>;

export function useDuressEnrollmentPanel(props: DuressEnrollmentPanelProps) {
  const state = useDuressEnrollmentState(props);
  const derived = useMemo(
    () =>
      deriveEnrollmentPanel({
        props: state.props,
        catalog: state.catalog,
        scope: state.scope,
        presetId: state.presetId,
        advancedJson: state.advancedJson,
        mode: state.mode,
        checklist: state.checklist,
        importRaw: state.importRaw,
        slot: state.slot,
        armed: state.armed,
        document: state.document,
      }),
    [
      state.props,
      state.catalog,
      state.scope,
      state.presetId,
      state.advancedJson,
      state.mode,
      state.checklist,
      state.importRaw,
      state.slot,
      state.armed,
      state.document,
    ],
  );

  const toggleCheck = (key: keyof ArmingChecklist, value: boolean) =>
    toggleArmingChecklist(state.setChecklist, key, value);

  const runRehearsal = () =>
    runEnrollmentRehearsal({
      catalogDurableStorage: state.catalog.durableStorage,
      document: state.document,
      setRehearsalNote: state.setRehearsalNote,
      toggleCheck,
    });

  const onReplaceCode = (e: FormEvent) =>
    void submitEnrolledCodeReplacement({
      event: e,
      document: state.document,
      codeDraft: state.codeDraft,
      prevCodeDraft: state.prevCodeDraft,
      slot: state.slot,
      scope: state.scope,
      enrollmentState: state.enrollmentState,
      setCodeDraft: state.setCodeDraft,
      setPrevCodeDraft: state.setPrevCodeDraft,
      setCodeError: state.setCodeError,
      setEnrollmentState: state.setEnrollmentState,
      setSlot: state.setSlot,
      toggleCheck,
    });

  const onDisarm = () =>
    void disarmEnrollmentProfile({
      slot: state.slot,
      setSlot: state.setSlot,
      setArmed: state.setArmed,
      setEnrollmentState: state.setEnrollmentState,
      toggleCheck,
      onDisarm: state.props.onDisarm,
    });

  const onArm = () =>
    void armEnrollmentProfile({
      document: state.document,
      armReady: derived.armReady,
      preset: derived.preset,
      mode: state.mode,
      presetId: state.presetId,
      recipients: state.recipients,
      enrollmentState: state.enrollmentState,
      checklist: state.checklist,
      setRehearsalNote: state.setRehearsalNote,
      setEnrollmentState: state.setEnrollmentState,
      setArmed: state.setArmed,
      onArm: state.props.onArm,
    });

  return {
    ...state,
    ...derived,
    toggleCheck,
    runRehearsal,
    onReplaceCode,
    onDisarm,
    onArm,
  };
}
