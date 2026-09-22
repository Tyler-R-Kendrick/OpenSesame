import type { CompilerCatalog, PolicyDocument } from "@opensesame/contracts";
import {
  type ArmingChecklist,
  type CodeSlotStatus,
  type PresetId,
  buildOwnerStatusView,
  canArmProfile,
  enrollmentFocusOrder,
  explainArmBlockers,
  exportPolicyPreview,
  getPresetMeta,
  mobileLayoutHints,
  previewCompiledPolicy,
  previewImport,
  previewImportDocument,
  publicCodeSlotView,
  statusLabelsForAudience,
  statusViewForPresentation,
} from "../../../lib/duress/settings/index.js";

/** Props of the Settings → Security duress enrollment panel (SETTINGS-A..E). */
export type DuressEnrollmentPanelProps = {
  catalog?: CompilerCatalog;
  scope?: {
    ownerPrincipalRef: string;
    organizationRef: string | null;
    vaultRef: string;
    deviceBindingRef: string;
    compartmentRefs: readonly string[];
  };
  onArm?: (args: {
    checklist: ArmingChecklist;
    presetId: PresetId | null;
    document: PolicyDocument;
  }) => void;
  onDisarm?: () => void;
  authorizedOwner?: boolean;
  presentation?: "normal" | "restricted" | "decoy" | "locked" | "unchanged";
  viewportWidth?: number;
};

type EnrollmentPanelInput = {
  props: DuressEnrollmentPanelProps;
  catalog: CompilerCatalog;
  scope: {
    ownerPrincipalRef: string;
    organizationRef: string | null;
    vaultRef: string;
    deviceBindingRef: string;
    compartmentRefs: readonly string[];
  };
  presetId: PresetId;
  advancedJson: string;
  mode: "preset" | "advanced";
  checklist: ArmingChecklist;
  importRaw: string;
  slot: CodeSlotStatus | null;
  armed: boolean;
  document: PolicyDocument | null;
};

function enrollmentStatusViews(input: EnrollmentPanelInput) {
  const ownerStatus = buildOwnerStatusView({
    armed: input.armed,
    profileCount: input.document?.profiles.length ?? 0,
    rehearsalPassed: input.checklist.rehearsalPassed,
    incidentState: null,
    recoveryPolicyRef:
      input.document?.profiles[0]?.effects.recoveryPolicyRef ?? null,
  });
  const audience =
    input.props.authorizedOwner === false
      ? "foreground_session"
      : "authorized_owner";
  const presentation = input.props.presentation ?? "normal";
  return {
    ownerStatus,
    foregroundLabels: statusLabelsForAudience(
      ownerStatus,
      audience,
      presentation,
    ),
    decoySafe: statusViewForPresentation(
      presentation,
      input.props.authorizedOwner !== false,
    ),
  };
}

function enrollmentImportViews(input: EnrollmentPanelInput) {
  const importPreview = input.importRaw
    ? previewImport(
        input.importRaw,
        input.catalog,
        input.importRaw.trimStart().startsWith("{") ? "json" : "yaml",
      )
    : null;
  const importDocPreview = input.document
    ? previewImportDocument(input.document, input.catalog)
    : null;
  const exportBlob = input.document
    ? exportPolicyPreview(input.document)
    : null;
  return { importPreview, importDocPreview, exportBlob };
}

export function deriveEnrollmentPanel(input: EnrollmentPanelInput) {
  const preset = getPresetMeta(input.presetId);
  const preview = input.document
    ? previewCompiledPolicy(input.document, input.catalog, input.checklist)
    : null;
  const statusViews = enrollmentStatusViews(input);
  const importViews = enrollmentImportViews(input);
  return {
    preset,
    preview,
    layout: mobileLayoutHints(input.props.viewportWidth ?? 1024),
    focusOrder: enrollmentFocusOrder(),
    ...statusViews,
    blockers: explainArmBlockers(input.checklist),
    armReady: canArmProfile(input.checklist) && preview?.ok === true,
    ...importViews,
    slotView: input.slot ? publicCodeSlotView(input.slot) : null,
  };
}
