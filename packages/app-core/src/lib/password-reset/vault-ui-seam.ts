/**
 * Vault chrome for optional `ai.password-reset` (ADR 0130). Core rotation UI
 * calls through this record so ItemDetail never imports readiness or run
 * trackers. The Pages module installs real hooks when the capability activates.
 */

export type VaultResetRunPhase =
  | "queued"
  | "in-progress"
  | "needs-you"
  | "done"
  | "failed";

export type PasswordResetReadinessSnapshot =
  | { ok: true }
  | { ok: false; reason: "feature-off" | "runtime" | "model" };

export type PasswordResetVaultUiSeams = {
  subscribeRuns: (listener: () => void) => () => void;
  runPhaseFor: (scope: string, itemId: string) => VaultResetRunPhase | null;
  evaluateReadiness: (
    approved: readonly string[] | undefined,
  ) => Promise<PasswordResetReadinessSnapshot>;
};

const noop = () => {};

export const passwordResetVaultUiSeams: PasswordResetVaultUiSeams = {
  subscribeRuns: () => noop,
  runPhaseFor: () => null,
  evaluateReadiness: async () => ({ ok: false, reason: "feature-off" }),
};

export function installPasswordResetVaultUi(
  implementation: PasswordResetVaultUiSeams,
): () => void {
  const previous = { ...passwordResetVaultUiSeams };
  Object.assign(passwordResetVaultUiSeams, implementation);
  return () => {
    Object.assign(passwordResetVaultUiSeams, previous);
  };
}
