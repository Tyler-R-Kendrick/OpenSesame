import type { VaultItem } from "@opensesame/vault-core";
import { shareText as shareSecret } from "./vault-section-model.js";

/**
 * Text a one-time share sends, with account username on its own line when set.
 */
export function shareText(item: VaultItem): string | null {
  const secret = shareSecret(item);
  if (secret === null || item.kind !== "account") return secret;
  const user = accountUsernameLine(item);
  return user !== "" ? `${user}\n${secret}` : secret;
}

/** Account username when set; empty for every other kind. */
export function accountUsernameLine(item: VaultItem): string {
  if (item.kind !== "account") return "";
  return item.username.trim();
}
