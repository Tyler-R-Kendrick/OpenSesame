/**
 * Email must never be used as an automatic account-link key.
 * Callers may still store email on a mapping after explicit user confirmation.
 */
export interface EmailLinkPolicy {
  /** Always false for OpenSesame — documents the invariant. */
  readonly autoLinkByEmail: false;
  /**
   * Returns true only when an explicit operator/user-confirmed link is requested.
   * Looking up by email alone never links or merges principals.
   */
  shouldAutoLinkOnEmail(_email: string): false;
  /**
   * Resolve whether two mappings may be merged. Email equality alone is insufficient.
   */
  canMergeByEmailAlone(
    a: { email?: string; principalId: string },
    b: { email?: string; principalId: string },
  ): boolean;
}

export const noEmailAutoLinkPolicy: EmailLinkPolicy = {
  autoLinkByEmail: false,
  shouldAutoLinkOnEmail() {
    return false;
  },
  canMergeByEmailAlone() {
    return false;
  },
};
