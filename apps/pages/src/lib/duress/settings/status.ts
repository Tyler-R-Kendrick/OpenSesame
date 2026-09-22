/**
 * Authorized status / recovery views.
 * Decoy and restricted foregrounds must not receive sensitive labels.
 */

export type PresentationClass =
  | "normal"
  | "restricted"
  | "decoy"
  | "locked"
  | "unchanged";

export type DuressStatusView = Readonly<{
  presentation: PresentationClass;
  title: string;
  detail: string;
  showRecoveryControls: boolean;
  showPolicyLabels: boolean;
  showIncidentIds: boolean;
}>;

const FOREGROUND_SAFE: ReadonlySet<PresentationClass> = new Set([
  "restricted",
  "decoy",
  "locked",
  "unchanged",
]);

export function statusViewForPresentation(
  presentation: PresentationClass,
  authorizedOwner: boolean,
): DuressStatusView {
  if (!authorizedOwner || FOREGROUND_SAFE.has(presentation)) {
    // Ordinary-looking / decoy foreground — no sensitive policy labels.
    if (presentation === "decoy") {
      return {
        presentation,
        title: "Vault",
        detail: "Unlocked.",
        showRecoveryControls: false,
        showPolicyLabels: false,
        showIncidentIds: false,
      };
    }
    if (presentation === "restricted") {
      return {
        presentation,
        title: "Vault",
        detail: "Some items are unavailable.",
        showRecoveryControls: false,
        showPolicyLabels: false,
        showIncidentIds: false,
      };
    }
    if (presentation === "locked" || presentation === "unchanged") {
      return {
        presentation,
        title: "Unavailable",
        detail: "Try again later.",
        showRecoveryControls: false,
        showPolicyLabels: false,
        showIncidentIds: false,
      };
    }
  }

  return {
    presentation,
    title: "Duress protection",
    detail: "Owner status and recovery controls.",
    showRecoveryControls: true,
    showPolicyLabels: true,
    showIncidentIds: true,
  };
}

/** Permission-prompt absence: activation UI never requests new browser permissions. */
export function activationRequiresNewPermissionPrompt(): false {
  return false;
}
