import type { VaultItem } from "@opensesame/vault-core";
import { shareText as shareSecret } from "./vault-section-model.js";

/**
 * Text a one-time share sends, with account username on its own line when set.
 */
export function shareText(item: VaultItem): string | null {
  const secret = shareSecret(item);
  if (secret === null || item.kind !== "account") return secret;
  const user = item.username.trim();
  return user !== "" ? `${user}\n${secret}` : secret;
}
