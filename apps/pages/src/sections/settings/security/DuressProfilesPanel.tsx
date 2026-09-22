/**
 * Security sheet panel for duress profiles (SETTINGS).
 * Wires compiler exposure into the shared DuressSettingsPanel presentation.
 */

import type { CompilerCatalog, PolicyDocument } from "@opensesame/contracts";
import { createElement, useMemo } from "react";
import { DuressSettingsPanel } from "../../../components/duress/DuressSettingsPanel.js";
import {
  type ArmingChecklist,
  type PolicyPreview,
  type PresetId,
  formatExposureLines,
  previewPolicy,
} from "../../../lib/duress/settings/index.js";

export type DuressProfilesPanelProps = Readonly<{
  document: PolicyDocument | null;
  catalog: CompilerCatalog;
  onArm: (checklist: ArmingChecklist, presetId: PresetId) => void;
  reducedMotion?: boolean;
}>;

export function DuressProfilesPanel(props: DuressProfilesPanelProps) {
  const document = props.document;
  if (!document) {
    return null;
  }

  const preview = useMemo((): PolicyPreview => {
    return previewPolicy(document, props.catalog, {
      ownerConsent: false,
      destructiveAck: false,
      rehearsalPassed: false,
      durableStorage: true,
      enrolledTriggers: false,
      exposureReviewed: false,
    });
  }, [document, props.catalog]);

  const error = preview.compiled.ok
    ? null
    : preview.compiled.diagnostics
        .map((d) => `${d.code}: ${d.message}`)
        .join("; ");

  const exposureSummary = preview.compiled.ok
    ? formatExposureLines(preview.compiled.exposures)
    : ["Policy will not compile until diagnostics are resolved."];

  return createElement(
    "div",
    {
      className: "duress-profiles-panel",
      role: "region",
      "aria-label": "Duress profiles",
    },
    error
      ? createElement("p", { role: "alert", className: "duress-error" }, error)
      : null,
    createElement(DuressSettingsPanel, {
      exposureSummary,
      onArm: props.onArm,
      reducedMotion: props.reducedMotion,
    }),
  );
}
