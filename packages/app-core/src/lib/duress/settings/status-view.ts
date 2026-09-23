/**
 * Authorized status / recovery views.
 * Decoy and restricted foreground must not show sensitive recovery labels.
 */

export type PresentationForeground =
  | "normal"
  | "restricted"
  | "decoy"
  | "locked"
  | "unchanged";

export type StatusAudience = "authorized_owner" | "foreground_session";

export type RecoveryStatusSnippet = Readonly<{
  incidentState: string;
  recoveryAvailable: boolean;
  recoveryPolicyRef: string | null;
  holdKind: string | null;
  /** May be redacted for restricted/decoy foreground. */
  labels: readonly string[];
}>;

const SENSITIVE_LABEL_RE =
  /recovery|custodian|hold|removal|alert.?route|policy|compartment|share/i;

/**
 * Build labels for status UI. Forbidden sensitive labels on decoy/restricted
 * foreground sessions (SETTINGS-D).
 */
export function statusLabelsForAudience(
  snippet: RecoveryStatusSnippet,
  audience: StatusAudience,
  presentation: PresentationForeground,
): readonly string[] {
  if (audience === "authorized_owner") {
    return snippet.labels;
  }

  const suppressSensitive =
    presentation === "decoy" || presentation === "restricted";

  if (!suppressSensitive) {
    // Locked / unchanged / normal foreground still avoid recovery ceremony
    // details unless authorized — keep only generic availability.
    return snippet.labels.filter((l) => !SENSITIVE_LABEL_RE.test(l));
  }

  // Decoy/restricted: no sensitive recovery / custodian / hold labels.
  return ["Vault available"];
}

export function buildOwnerStatusView(input: {
  armed: boolean;
  profileCount: number;
  rehearsalPassed: boolean;
  incidentState: string | null;
  recoveryPolicyRef: string | null;
}): RecoveryStatusSnippet {
  const labels: string[] = [];
  labels.push(input.armed ? "Duress armed" : "Duress not armed");
  labels.push(`Profiles configured: ${input.profileCount}`);
  labels.push(
    input.rehearsalPassed
      ? "Rehearsal passed"
      : "Rehearsal required before arming",
  );
  if (input.incidentState) {
    labels.push(`Incident state: ${input.incidentState}`);
  }
  if (input.recoveryPolicyRef) {
    labels.push(`Recovery policy: ${input.recoveryPolicyRef}`);
  }
  return {
    incidentState: input.incidentState ?? "none",
    recoveryAvailable: Boolean(input.recoveryPolicyRef),
    recoveryPolicyRef: input.recoveryPolicyRef,
    holdKind: null,
    labels,
  };
}
