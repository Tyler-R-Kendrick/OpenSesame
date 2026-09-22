import "./duress-settings.css";
import { DuressEnrollmentPanelBody } from "./DuressEnrollmentPanelBody.js";
import { useDuressEnrollmentPanel } from "./useDuressEnrollmentPanel.js";

export type DuressEnrollmentPanelProps = {
  catalog?: import("@opensesame/contracts").CompilerCatalog;
  scope?: {
    ownerPrincipalRef: string;
    organizationRef: string | null;
    vaultRef: string;
    deviceBindingRef: string;
    compartmentRefs: readonly string[];
  };
  onArm?: (args: {
    checklist: import("../../../lib/duress/settings/index.js").ArmingChecklist;
    presetId: import("../../../lib/duress/settings/index.js").PresetId | null;
    document: import("@opensesame/contracts").PolicyDocument;
  }) => void;
  onDisarm?: () => void;
  authorizedOwner?: boolean;
  presentation?: "normal" | "restricted" | "decoy" | "locked" | "unchanged";
  viewportWidth?: number;
};

/** Settings → Security duress enrollment panel (SETTINGS-A..E). */
export function DuressEnrollmentPanel(props: DuressEnrollmentPanelProps) {
  const view = useDuressEnrollmentPanel(props);
  return <DuressEnrollmentPanelBody vm={view} />;
}

export default DuressEnrollmentPanel;
