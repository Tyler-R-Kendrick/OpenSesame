export type RecoveryKind = "identity" | "authenticator" | "vault_key";

/** Identity recovery is not vault-key recovery (J-RECOVERY). */
export function describeRecovery(kind: RecoveryKind): string {
  if (kind === "identity") {
    return "Replace a sign-in method. This does not unwrap the vault.";
  }
  if (kind === "authenticator") {
    return "Replace one enrolled authenticator using a remaining key or recovery codes.";
  }
  return "Loss of every unwrap method cannot be bypassed by email verification.";
}

export function emailCannotUnwrapVault(): boolean {
  return true;
}
