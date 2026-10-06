import { concealedValue } from "@opensesame/app-core/sections/vault-section-model.js";
import {
  type AccountItem,
  type VaultItem,
  credentialLine,
  handoff,
  produceAccountPassword,
} from "@opensesame/vault-core";

/**
 * Whether the list's "copy secret" has something to give: an account's
 * password counts when the facade produces one, whole or up to its pepper's slot;
 * one with no password gives its API key or token as a header line.
 */
export function canCopySecret(item: VaultItem): boolean {
  if (item.kind !== "account") return Boolean(concealedValue(item));
  return (
    handoff(produceAccountPassword(item)) !== null ||
    credentialLine(item) !== null
  );
}

/**
 * What an account's copy puts out (ADR 0174): the password, or what comes before
 * a pepper's slot; with no password, its API key or token as the header line a
 * request takes. `null` is nothing to copy. The pepper is never asked for.
 */
export function accountSecretToCopy(item: AccountItem): string | null {
  return handoff(produceAccountPassword(item))?.now ?? credentialLine(item);
}
