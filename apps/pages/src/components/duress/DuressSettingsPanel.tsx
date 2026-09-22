import { createElement, useMemo, useState } from "react";
import {
  type ArmingChecklist,
  PRESET_CATALOG,
  type PresetId,
  canArmProfile,
} from "../../lib/duress/settings/index.js";
import { DuressSettingsPanelView } from "./DuressSettingsPanelView.js";

/**
 * Duress settings panel — presets, consent, rehearsal gates.
 * Enrolled codes are never displayed. No new permission prompts at arm time.
 */
export function DuressSettingsPanel(props: {
  onArm: (checklist: ArmingChecklist, presetId: PresetId) => void;
  exposureSummary: string[];
  reducedMotion?: boolean;
}) {
  const [presetId, setPresetId] = useState<PresetId>("SC-RESTRICTED");
  const [checklist, setChecklist] = useState<ArmingChecklist>({
    ownerConsent: false,
    destructiveAck: false,
    rehearsalPassed: false,
    durableStorage: true,
    enrolledTriggers: false,
    exposureReviewed: false,
  });

  const ready = canArmProfile(checklist);
  const preset = useMemo(
    () => PRESET_CATALOG.find((p) => p.id === presetId) ?? PRESET_CATALOG[0],
    [presetId],
  );
  const motionClass = props.reducedMotion
    ? "duress-settings--reduced"
    : "duress-settings";

  return createElement(DuressSettingsPanelView, {
    motionClass,
    presetId,
    setPresetId,
    preset,
    exposureSummary: props.exposureSummary,
    checklist,
    setChecklist,
    ready,
    onArm: () => props.onArm(checklist, presetId),
  });
}
