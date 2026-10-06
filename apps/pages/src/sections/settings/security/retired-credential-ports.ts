import {
  clearRetiredCredentialEvents,
  enrollRetiredCredential,
  refreshRetiredCredentialStatus,
  removeRetiredCredential,
  retiredCredentialEnrollmentSupported,
  retiredCredentialStatus,
} from "@opensesame/app-core/lib/retired-credentials/index.js";

/** The sheet's owner-authenticated service boundary; tests supply its behavior. */
export const retiredCredentialUiPorts = {
  clearRetiredCredentialEvents,
  enrollRetiredCredential,
  removeRetiredCredential,
  retiredCredentialEnrollmentSupported,
  retiredCredentialStatus,
  refreshStatus: refreshRetiredCredentialStatus,
};
