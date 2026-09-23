import "./duress-settings.css";
import { DuressEnrollmentPanelBody } from "./DuressEnrollmentPanelBody.js";
import { useDuressEnrollmentPanel } from "./useDuressEnrollmentPanel.js";

export type { DuressEnrollmentPanelProps } from "@opensesame/app-core/routes/settings/security/duress-enrollment-derived.js";
import type { DuressEnrollmentPanelProps } from "@opensesame/app-core/routes/settings/security/duress-enrollment-derived.js";

/** Settings → Security duress enrollment panel (SETTINGS-A..E). */
export function DuressEnrollmentPanel(props: DuressEnrollmentPanelProps) {
  const view = useDuressEnrollmentPanel(props);
  return <DuressEnrollmentPanelBody vm={view} />;
}

export default DuressEnrollmentPanel;
