/**
 * Settings › Security shell exports.
 * DuressProfilesPanel mounts behind feature mode; default remains off (INV-01).
 */

export { DuressProfilesPanel } from "./DuressProfilesPanel.js";
export type { DuressProfilesPanelProps } from "./DuressProfilesPanel.js";
export {
  onCompleteUnlockCodeSubmission,
  persistEnrollmentStateForUnlock,
  loadEnrollmentStateForUnlock,
  routeCompleteUnlockSubmission,
} from "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js";
